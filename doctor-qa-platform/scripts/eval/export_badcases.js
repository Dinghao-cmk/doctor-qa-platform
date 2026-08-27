/**
 * scripts/eval/export_badcases.js - 导出 badcase 样本（学习闭环的“标注入口”）
 *
 * 用途：把线上自动收集的检索弱命中/点踩问题导出为待标注清单，
 *       人工标注期望命中的书/章节后，并入 scripts/eval/questions.json 扩充黄金题库，
 *       再用 run_eval.js 回归 / optimize_fusion.js 调参。
 *
 * 用法：
 *   node scripts/eval/export_badcases.js                    # 导出全部 pending，默认文件 badcases_<时间戳>.json
 *   node scripts/eval/export_badcases.js --status all       # 导出全部状态
 *   node scripts/eval/export_badcases.js --reason weak_hit  # 只导出某类原因
 *   node scripts/eval/export_badcases.js --output out.json  # 指定输出文件
 */
const fs = require('fs')
const path = require('path')
const { db } = require('../../src/db')

const REASON_LABEL = {
    no_result: '知识库零命中（走了兜底）',
    weak_hit: 'rerank 判定无直接相关（检索到但不可用）',
    feedback_dislike: '用户点踩',
}

const parseArgs = () => {
    const args = process.argv.slice(2)
    const pick = (flag) => {
        const i = args.indexOf(flag)
        return i >= 0 && args[i + 1] ? args[i + 1] : null
    }
    return {
        status: pick('--status') || 'pending',
        reason: pick('--reason') || null,
        output: pick('--output') || null,
    }
}

const main = async () => {
    const { status, reason, output } = parseArgs()

    const q = db('qa_badcase').select(
        'id', 'question', 'reason', 'sources', 'model', 'note', 'hit_count', 'status', 'created_at'
    )
    if (status !== 'all') q.where('status', status)
    if (reason) q.where('reason', reason)
    const rows = await q.orderBy('hit_count', 'desc').orderBy('created_at', 'desc')

    if (rows.length === 0) {
        console.log('（无符合条件的数据）')
        await db.destroy()
        return
    }

    // 汇总统计
    const byReason = {}
    for (const r of rows) byReason[r.reason] = (byReason[r.reason] || 0) + 1
    console.log(`共 ${rows.length} 条 badcase（status=${status}${reason ? `, reason=${reason}` : ''}）:`)
    for (const [k, v] of Object.entries(byReason)) console.log(`  - ${REASON_LABEL[k] || k}: ${v} 条`)

    // 标注清单（人工补 bookTitle 后即可并入 questions.json）
    const out = {
        generatedAt: new Date().toISOString(),
        note: '人工标注每条的 bookTitle（期望命中的书，与知识库中 rag_source_doc.title 一致），随后可并入 scripts/eval/questions.json',
        cases: rows.map(r => ({
            id: `bc${r.id}`,
            question: r.question,
            bookTitle: null, // ← 人工标注
            chapter: null,   // ← 可选
            category: null,  // ← 可选
            reason: r.reason,
            hitCount: r.hit_count,
            sources: r.sources,   // 当时命中的书（诊断用）
            note: r.note || '',
            createdAt: r.created_at,
        })),
    }

    const outFile = output || path.join(__dirname, 'results', `badcases_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.json`)
    if (!fs.existsSync(path.dirname(outFile))) fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8')
    console.log(`\n已导出标注清单: ${outFile}`)
    console.log('标注流程：补 bookTitle → 并入 questions.json → node scripts/eval/run_eval.js 回归验证')

    await db.destroy()
}

main().catch(e => { console.error('导出失败:', e.message); process.exit(1) })
