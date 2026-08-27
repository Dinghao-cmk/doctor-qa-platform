/**
 * scripts/eval/run_eval.js - 黄金题库评测脚本
 *
 * 用法：
 *   node scripts/eval/run_eval.js                 # 跑评测（自动指标）
 *   node scripts/eval/run_eval.js --judge         # 跑评测 + LLM 评委打分（4 维 0-5）
 *   node scripts/eval/run_eval.js --compare a.json b.json   # 对比两次评测结果
 *
 * 输出：scripts/eval/results/result_<时间戳>.json
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const config = require('../../src/config')

const QUESTIONS_FILE = path.join(__dirname, 'questions.json')
const RESULT_DIR = path.join(__dirname, 'results')

const BASE_URL = process.env.EVAL_BASE || 'http://localhost:3009'
const CONCURRENCY = 3 // 并发数
const TIMEOUT = 120000 // 单题超时

const postAsk = (question, mode = '', extra = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ question, ...(mode ? { mode } : {}), ...extra })
    const req = http.request({
        hostname: BASE_URL.replace(/^https?:\/\//, '').split(':')[0],
        port: (BASE_URL.split(':')[2] || '80'),
        path: '/api/ask',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: TIMEOUT,
    }, res => {
        let b = ''
        res.on('data', c => b += c)
        res.on('end', () => {
            try {
                const data = JSON.parse(b)
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${(data.error || b).slice(0, 120)}`))
                resolve(data)
            } catch (e) {
                reject(new Error(`JSON解析失败: ${b.slice(0, 120)}`))
            }
        })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')) })
    req.write(body)
    req.end()
})

/** 并发控制跑题 */
const runQuestions = async (questions, mode = '', extra = {}) => {
    const results = []
    let idx = 0
    const worker = async () => {
        while (idx < questions.length) {
            const q = questions[idx++]
            const t0 = Date.now()
            try {
                const r = await postAsk(q.question, mode, extra)
                results.push({ ...q, ok: true, duration: Date.now() - t0, ...r })
            } catch (e) {
                results.push({ ...q, ok: false, error: e.message, duration: Date.now() - t0 })
            }
            process.stdout.write(`\r进度: ${results.length}/${questions.length}`)
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    process.stdout.write('\n')
    return results
}

/** 自动指标统计 */
const summarize = (results) => {
    const ok = results.filter(r => r.ok)
    const fail = results.length - ok.length
    const noResult = ok.filter(r => r.meta && r.meta.noResult).length
    const withSources = ok.filter(r => r.sources && r.sources.length > 0).length

    // 引用统计
    let refTotal = 0, refInvalid = 0, refFixed = 0, refRetried = 0, coverageSum = 0, coverageCount = 0
    for (const r of ok) {
        const c = r.meta && r.meta.citation
        if (!c) continue
        refTotal += c.total
        refInvalid += (c.invalid || []).length
        if (c.fixed) refFixed++
        if (c.retried) refRetried++
        if (c.total > 0) { coverageSum += c.coverage; coverageCount++ }
    }

    // 模型分布
    const modelDist = {}
    for (const r of ok) {
        const m = r.meta && r.meta.model ? r.meta.model : 'none'
        modelDist[m] = (modelDist[m] || 0) + 1
    }

    const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0

    // 期望书命中率：sources 中是否包含该题期望命中的书
    let bookHit = 0
    for (const r of ok) {
        const got = new Set((r.sources || []).map(s => s.bookTitle).filter(Boolean))
        if (got.has(r.bookTitle)) bookHit++
    }
    const bookMiss = ok.filter(r => {
        const got = new Set((r.sources || []).map(s => s.bookTitle).filter(Boolean))
        return !got.has(r.bookTitle)
    }).map(r => ({ id: r.id, book: r.bookTitle, question: r.question, got: [...new Set((r.sources || []).map(s => s.bookTitle).filter(Boolean))].slice(0, 3) }))

    return {
        total: results.length,
        ok: ok.length,
        fail,
        failDetails: results.filter(r => !r.ok).map(r => ({ id: r.id, question: r.question, error: r.error })),
        noResult,
        withSources,
        noResultRate: ok.length ? Number((noResult / ok.length).toFixed(2)) : 0,
        bookHit,
        bookHitRate: ok.length ? Number((bookHit / ok.length).toFixed(2)) : 0,
        bookMiss,
        avgSources: Number(avg(ok.map(r => (r.sources || []).length)).toFixed(2)),
        avgBooks: Number(avg(ok.map(r => r.meta ? (r.meta.bookCount || 0) : 0)).toFixed(2)),
        avgDuration: Math.round(avg(ok.map(r => r.duration))),
        avgAnswerLen: Math.round(avg(ok.map(r => (r.answer || '').length))),
        refTotal,
        refInvalid,
        refFixed,
        refRetried,
        refCoverageAvg: coverageCount ? Number((coverageSum / coverageCount).toFixed(2)) : 0,
        modelDist,
        promptVersions: [...new Set(ok.map(r => r.meta && r.meta.promptVersion).filter(Boolean))],
    }
}

/** LLM 评委打分（4 维 0-5）
 * 注意：判卷任务简单，用快模型（flash）即可，且勿用 reasoner（推理 token 会占满 max_tokens）
 */
const judgeAnswer = async (question, answer, sources, category) => {
    const superagent = require('superagent')
    const prompt = `你是医学知识回答质量评委。根据参考资料，对下面的回答进行评分。

## 问题类型
${category || 'general'}

## 问题
${question}

## 参考答案来源（仅展示标题）
${(sources || []).map((s, i) => `${i + 1}. ${s.docTitle || s.bookTitle || '未知'}`).join('\n')}

## 回答
${answer.slice(0, 800)}

## 评分维度（每项 0-5 分，5=优秀）
- accuracy: 医学准确性（数值/标准是否正确，是否编造）
- completeness: 完整性（是否回答了问题核心，要点是否齐全）
- citation: 引用规范（[参考N] 是否标注规范、是否合理对应来源）
- format: 格式规范性（分点清晰、结构合理、简洁）

## 要求
只输出 JSON：{"accuracy": 4, "completeness": 3, "citation": 4, "format": 5, "summary": "一句话总评"}`

    try {
        const res = await superagent
            .post(config.llm.apiUrl)
            .send({
                model: config.llm.model, // 判卷用快模型（reasoner 的推理 token 会占满 max_tokens 导致无输出）
                messages: [
                    { role: 'system', content: '你是一个严格的医学问答质量评委，只输出JSON。' },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.1,
                max_tokens: 3000, // flash 可能先输出草稿再输出 JSON，给足余量防截断（曾因 500/1000 截断导致评分失败）
            })
            .set('Content-Type', 'application/json')
            .set('Authorization', `Bearer ${config.llm.apiKey}`)
            .timeout({ response: 20000 })
        const text = res.body?.choices?.[0]?.message?.content?.trim() || ''
        const m = text.match(/\{[\s\S]*\}/)
        if (!m) {
            console.error(`  [judge] 返回无JSON内容: ${text.slice(0, 80) || '(空)'}`)
            return null
        }
        const parsed = JSON.parse(m[0])
        return {
            accuracy: parsed.accuracy, completeness: parsed.completeness,
            citation: parsed.citation, format: parsed.format, summary: parsed.summary || '',
        }
    } catch (e) {
        console.error(`  [judge] 评分失败: ${e.message}`)
        return null
    }
}

const printSummary = (s, label = '评测汇总') => {
    console.log(`\n════════ ${label} ════════`)
    console.log(`总题数: ${s.total} | 成功: ${s.ok} | 失败: ${s.fail}${s.fail ? ' ❌' : ''}`)
    console.log(`未收录率: ${s.noResultRate} (${s.noResult}/${s.ok}) | 有来源: ${s.withSources}/${s.ok}`)
    console.log(`平均来源: ${s.avgSources} 条 | 平均命中书: ${s.avgBooks} 本`)
    console.log(`⭐ 期望书命中率: ${(s.bookHitRate * 100).toFixed(1)}% (${s.bookHit}/${s.ok})`)
    if (s.bookMiss && s.bookMiss.length) {
        console.log('未命中期望书的题:')
        s.bookMiss.forEach(m => console.log(`  - ${m.id} [${m.book}] ${m.question} → 实际: ${m.got.join(' | ') || '(无)'}`))
    }
    console.log(`平均耗时: ${s.avgDuration}ms | 平均回答长度: ${s.avgAnswerLen} 字`)
    console.log(`引用: 共${s.refTotal}个, 非法${s.refInvalid}个, 修正${s.refFixed}次, 重生成${s.refRetried}次, 平均覆盖率${s.refCoverageAvg}`)
    console.log(`模型分布: ${JSON.stringify(s.modelDist)}`)
    if (s.promptVersions.length) console.log(`prompt版本: ${s.promptVersions.join(', ')}`)
    if (s.failDetails.length) {
        console.log('失败明细:')
        s.failDetails.forEach(f => console.log(`  - ${f.id} [${f.question}] ${f.error}`))
    }
    if (s.avgScores) {
        console.log(`\nLLM 评委均分（0-5）:`)
        console.log(`  accuracy=${s.avgScores.accuracy} completeness=${s.avgScores.completeness} citation=${s.avgScores.citation} format=${s.avgScores.format} 综合=${s.avgScores.overall}`)
    }
}

const main = async () => {
    const args = process.argv.slice(2)

    // 对比模式
    const cmpIdx = args.indexOf('--compare')
    if (cmpIdx >= 0) {
        const [fileA, fileB] = [args[cmpIdx + 1], args[cmpIdx + 2]]
        if (!fileA || !fileB) { console.error('用法: --compare a.json b.json'); process.exit(1) }
        const a = JSON.parse(fs.readFileSync(path.resolve(fileA), 'utf8'))
        const b = JSON.parse(fs.readFileSync(path.resolve(fileB), 'utf8'))
        printSummary(a.summary, '对比 - 基线')
        printSummary(b.summary, '对比 - 当前')
        console.log('\n差异 (当前 - 基线):')
        console.log(`  未收录率: ${b.summary.noResultRate} vs ${a.summary.noResultRate}`)
        console.log(`  平均来源: ${b.summary.avgSources} vs ${a.summary.avgSources}`)
        console.log(`  平均命中书: ${b.summary.avgBooks} vs ${a.summary.avgBooks}`)
        console.log(`  平均耗时: ${b.summary.avgDuration}ms vs ${a.summary.avgDuration}ms`)
        console.log(`  非法引用: ${b.summary.refInvalid} vs ${a.summary.refInvalid}`)
        console.log(`  引用覆盖率: ${b.summary.refCoverageAvg} vs ${a.summary.refCoverageAvg}`)
        if (a.summary.avgScores && b.summary.avgScores) {
            console.log(`  综合得分: ${b.summary.avgScores.overall} vs ${a.summary.avgScores.overall}`)
        }
        return
    }

    // 评测模式
    if (!fs.existsSync(QUESTIONS_FILE)) {
        console.error(`题库不存在: ${QUESTIONS_FILE}，请先运行 node scripts/eval/generate_questions.js`)
        process.exit(1)
    }
    let { questions } = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'))
    if (!questions || questions.length === 0) { console.error('题库为空'); process.exit(1) }

    // 按书过滤（新书专项题）：node run_eval.js --bookId 103
    const bookIdx = args.indexOf('--bookId')
    if (bookIdx >= 0) {
        const bid = parseInt(args[bookIdx + 1], 10)
        if (Number.isInteger(bid)) {
            questions = questions.filter(q => q.bookId === bid)
            console.log(`[过滤] 仅评测 bookId=${bid} 的专项题（${questions.length} 道）`)
            if (questions.length === 0) { console.error('该书没有专项题'); process.exit(1) }
        }
    }

    const useJudge = args.includes('--judge')
    // 对比实验模式（对应 /api/ask 的 mode 参数）：norag / weakrag / local / strong
    const modeIdx = args.indexOf('--mode')
    const mode = modeIdx >= 0 && args[modeIdx + 1] ? args[modeIdx + 1] : ''
    // 实验参数：覆盖检索阈值/返回条数（基线为默认 0.5/5）
    const thrIdx = args.indexOf('--threshold')
    const threshold = thrIdx >= 0 ? parseFloat(args[thrIdx + 1]) : null
    const limIdx = args.indexOf('--limit')
    const limit = limIdx >= 0 ? parseInt(args[limIdx + 1], 10) : null
    const extra = { ...(threshold != null ? { threshold } : {}), ...(limit != null ? { limit } : {}) }
    const tag = [threshold != null ? `thr${threshold}` : '', limit != null ? `lim${limit}` : ''].filter(Boolean).join('_')
    console.log(`题库 ${questions.length} 题，开始评测${mode ? `（mode=${mode}）` : ''}${tag ? `（${tag}）` : ''} (并发 ${CONCURRENCY}, 目标 ${BASE_URL})...`)

    const results = await runQuestions(questions, mode, extra)
    const summary = summarize(results)

    // LLM 评委打分（失败重试 2 次）
    if (useJudge) {
        console.log('\nLLM 评委打分中...')
        const scoreList = []
        const sleep = (ms) => new Promise(r => setTimeout(r, ms))
        for (const r of results) {
            if (!r.ok) continue
            let s = null
            // 指数退避重试 5 次（API 间歇性故障时提高成功率）
            for (let attempt = 0; attempt < 5 && !s; attempt++) {
                if (attempt > 0) {
                    const wait = Math.min(1000 * Math.pow(2, attempt), 16000)
                    console.log(`  [judge] ${r.id} 重试第${attempt}次（等待${wait}ms）...`)
                    await sleep(wait)
                }
                s = await judgeAnswer(r.question, r.answer, r.sources, r.category)
            }
            if (s) {
                r.score = s
                scoreList.push(s)
            } else {
                console.error(`  [judge] ${r.id} 评分失败（5次重试后放弃）: ${r.question}`)
            }
        }
        const avg = (k) => scoreList.length ? Number((scoreList.reduce((a, b) => a + b[k], 0) / scoreList.length).toFixed(2)) : 0
        summary.avgScores = {
            accuracy: avg('accuracy'), completeness: avg('completeness'),
            citation: avg('citation'), format: avg('format'),
            overall: Number(((avg('accuracy') + avg('completeness') + avg('citation') + avg('format')) / 4).toFixed(2)),
        }
    }

    // 保存结果
    if (!fs.existsSync(RESULT_DIR)) fs.mkdirSync(RESULT_DIR, { recursive: true })
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const outFile = path.join(RESULT_DIR, `result_${ts}${mode ? '_' + mode : ''}${tag ? '_' + tag : ''}${useJudge ? '_judged' : ''}.json`)
    fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2), 'utf8')

    printSummary(summary)
    console.log(`\n结果文件: ${outFile}`)
}

main().catch(e => { console.error('评测失败:', e.message); process.exit(1) })
