/**
 * scripts/eval/optimize_fusion.js - 检索融合参数自学习（黄金题库驱动）
 *
 * 目的：RRF 融合的通道权重 / k 值不再人工拍脑袋硬编码，而是基于黄金题库自动寻优，
 *       找到在当前知识库+题库下使“期望书命中率 / MRR@5”最优的参数组合。
 *
 * 原理：
 *   1. 对题库每题只跑一次三路检索（向量/关键词/标题，必要时含章节路径），缓存通道结果
 *   2. 坐标下降扫描参数组合，重放【融合→配额→去重】纯函数（与线上 hybridSearch 同一套逻辑），
 *      评估指标无需再请求 LLM，秒级出结果
 *   3. 输出最优参数；--apply 写回 qa_settings 表（key=search_fusion），60s 内线上动态生效
 *
 * 用法：
 *   node scripts/eval/optimize_fusion.js            # 只调参，打印对比结果
 *   node scripts/eval/optimize_fusion.js --apply    # 调参并写回配置（动态生效）
 *   node scripts/eval/optimize_fusion.js --limit 10 # 评估时每题的候选条数（默认 5，与线上一致）
 *   node scripts/eval/optimize_fusion.js --rounds 3 # 坐标下降轮数（默认 3）
 */
const fs = require('fs')
const path = require('path')
const { runPipeline, rrfFuse, quotaAndDedup } = require('../../src/services/search')
const { db } = require('../../src/db')

const QUESTIONS_FILE = path.join(__dirname, 'questions.json')
const DEFAULT_FUSION = { rrfK: 60, weights: { vector: 1, keyword: 1, title: 1, path: 0.8 } }

// ── 参数候选空间 ──────────────────────────────
// 第一轮粗粒度（含 0=关闭通道），后续轮以最优为中心 ±0.25 细扫
const WEIGHT_CANDIDATES = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]
const K_CANDIDATES = [30, 45, 60, 80, 100]

const parseArgs = () => {
    const args = process.argv.slice(2)
    return {
        apply: args.includes('--apply'),
        limit: (() => {
            const i = args.indexOf('--limit')
            return i >= 0 ? parseInt(args[i + 1], 10) : 5
        })(),
        rounds: (() => {
            const i = args.indexOf('--rounds')
            return i >= 0 ? parseInt(args[i + 1], 10) : 3
        })(),
    }
}

/**
 * 评估一组融合参数：对缓存通道重放融合+配额+去重，统计期望书命中率与 MRR@5
 * @param {Array} cases - [{ question, bookTitle, channels }]
 * @param {Object} fusion - 候选参数
 * @returns {{ bookHitRate, mrr5, hits, total, misses: [] }}
 */
const evaluate = (cases, fusion, limit) => {
    let hits = 0
    let mrrSum = 0
    const misses = []
    for (const c of cases) {
        const fused = rrfFuse(c.channels, fusion)
        const pipe = quotaAndDedup(fused, limit).slice(0, 20)
        let hitRank = 0 // 期望书第一次出现的 1-based 位置（0=未命中）
        pipe.forEach((s, i) => {
            if (!hitRank && s.bookTitle && c.bookTitle && s.bookTitle === c.bookTitle) hitRank = i + 1
        })
        if (hitRank > 0) {
            hits++
            mrrSum += hitRank <= 5 ? 1 / hitRank : 0 // MRR@5：前 5 名之外的命中不计
        } else {
            misses.push({ id: c.id, book: c.bookTitle, question: c.question })
        }
    }
    const total = cases.length
    return {
        bookHitRate: total ? Number((hits / total).toFixed(3)) : 0,
        mrr5: total ? Number((mrrSum / total).toFixed(4)) : 0,
        hits,
        total,
        misses,
    }
}

/** 两个评估结果比较：主指标 bookHitRate，次指标 MRR@5 */
const betterThan = (a, b) => a.bookHitRate !== b.bookHitRate
    ? a.bookHitRate > b.bookHitRate
    : a.mrr5 > b.mrr5

/** 坐标下降：逐轮逐参数在候选值中取最优，保持其他参数不变 */
const coordinateDescent = (cases, initFusion, rounds, limit) => {
    let params = { rrfK: initFusion.rrfK, weights: { ...initFusion.weights } }
    let best = evaluate(cases, params, limit)
    console.log(`[基线] 默认参数 ${JSON.stringify(params)} → 命中率 ${best.bookHitRate} (${best.hits}/${best.total}), MRR@5 ${best.mrr5}`)

    const keys = ['vector', 'keyword', 'title', 'path']
    for (let round = 1; round <= rounds; round++) {
        let improved = false
        // 每个参数独立扫描：权重先于 k，因为 k 对排序的影响是全局平滑的
        for (const key of keys) {
            const old = params.weights[key]
            let bestVal = old
            for (const v of WEIGHT_CANDIDATES) {
                const trial = { ...params, weights: { ...params.weights, [key]: v } }
                const s = evaluate(cases, trial, limit)
                if (betterThan(s, best)) {
                    best = s
                    bestVal = v
                    improved = true
                }
            }
            if (bestVal !== old) {
                params.weights[key] = bestVal
                console.log(`[第${round}轮] ${key}: ${old} → ${bestVal}（命中率 ${best.bookHitRate}, MRR@5 ${best.mrr5}）`)
            }
        }
        let bestK = params.rrfK
        for (const k of K_CANDIDATES) {
            const trial = { ...params, rrfK: k }
            const s = evaluate(cases, trial, limit)
            if (betterThan(s, best)) {
                best = s
                bestK = k
                improved = true
            }
        }
        if (bestK !== params.rrfK) {
            const oldK = params.rrfK
            params.rrfK = bestK
            console.log(`[第${round}轮] rrfK: ${oldK} → ${bestK}（命中率 ${best.bookHitRate}, MRR@5 ${best.mrr5}）`)
        }
        if (!improved) {
            console.log(`[第${round}轮] 无改进，提前收敛`)
            break
        }
    }
    return { params, score: best }
}

const main = async () => {
    const { apply, limit, rounds } = parseArgs()
    if (!fs.existsSync(QUESTIONS_FILE)) {
        console.error(`题库不存在: ${QUESTIONS_FILE}`)
        process.exit(1)
    }
    const { questions } = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'))
    const valid = questions.filter(q => q.bookTitle && q.question)
    console.log(`题库 ${questions.length} 题，有效（含期望书标注）${valid.length} 题，候选条数 limit=${limit}, 轮数=${rounds}`)

    // ── 阶段 1：对每题跑一次三路检索并缓存通道（唯一的 DB/API 开销） ──
    console.log('\n[阶段1] 逐题检索并缓存通道结果...')
    const cases = []
    for (let i = 0; i < valid.length; i++) {
        const q = valid[i]
        try {
            const { channels } = await runPipeline(q.question, { limit }, DEFAULT_FUSION)
            cases.push({ id: q.id, bookTitle: q.bookTitle, question: q.question, channels })
            process.stdout.write(`\r  进度: ${i + 1}/${valid.length}`)
        } catch (e) {
            console.error(`\n  题目 ${q.id} 检索失败，跳过: ${e.message}`)
        }
    }
    process.stdout.write('\n')
    if (cases.length === 0) {
        console.error('无可用题目，检查数据库连接与 embedding 配置')
        process.exit(1)
    }
    console.log(`  缓存完成，共 ${cases.length} 题参与调参`)

    // ── 阶段 2：坐标下降搜索最优参数（纯内存重放，秒级） ──
    console.log('\n[阶段2] 坐标下降调参中...')
    const { params, score } = coordinateDescent(cases, DEFAULT_FUSION, rounds, limit)

    // ── 阶段 3：输出对比 ──
    const baseline = evaluate(cases, DEFAULT_FUSION, limit)
    console.log('\n════════ 调参结果 ════════')
    console.log(`默认参数: ${JSON.stringify(DEFAULT_FUSION)}`)
    console.log(`  → 期望书命中率 ${baseline.bookHitRate} (${baseline.hits}/${baseline.total}), MRR@5 ${baseline.mrr5}`)
    console.log(`最优参数: ${JSON.stringify(params)}`)
    console.log(`  → 期望书命中率 ${score.bookHitRate} (${score.hits}/${score.total}), MRR@5 ${score.mrr5}`)
    console.log(`提升: 命中率 ${((score.bookHitRate - baseline.bookHitRate) * 100).toFixed(1)}pp, MRR@5 ${((score.mrr5 - baseline.mrr5) * 100).toFixed(2)}pp`)
    if (score.misses.length <= 10) {
        console.log('\n最优参数下未命中期望书的题:')
        score.misses.forEach(m => console.log(`  - ${m.id} [${m.book}] ${m.question}`))
    } else {
        console.log(`\n最优参数下仍有 ${score.misses.length} 题未命中（前 10 条）:`)
        score.misses.slice(0, 10).forEach(m => console.log(`  - ${m.id} [${m.book}] ${m.question}`))
    }

    // ── 阶段 4：写回配置（可选） ──
    if (apply) {
        const settings = require('../../src/services/settings')
        const rounded = {
            rrfK: params.rrfK,
            weights: Object.fromEntries(Object.entries(params.weights).map(([k, v]) => [k, Math.round(v * 100) / 100])),
        }
        await settings.set('search_fusion', JSON.stringify(rounded))
        console.log(`\n✅ 已写回 qa_settings.search_fusion = ${JSON.stringify(rounded)}（60s 缓存后线上动态生效）`)
    } else {
        console.log('\n（未写回配置。确认结果后加 --apply 使其生效）')
    }

    await db.destroy()
    process.exit(0)
}

main().catch(e => { console.error('调参失败:', e.message); process.exit(1) })
