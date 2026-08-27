/**
 * badcase.js - 检索弱命中样本收集服务（学习闭环第一步）
 *
 * 收集三类“检索不可用”样本，供人工标注后扩充黄金题库（scripts/eval/export_badcases.js），
 * 或驱动检索参数调优（scripts/eval/optimize_fusion.js）：
 *   - no_result          知识库零命中（走了兜底回答）
 *   - weak_hit           rerank 判定 level2=0（检索到段落但无直接相关）
 *   - feedback_dislike   用户点踩（问题/来源书/原因一并记录）
 *
 * 同一问题同一原因只保留一条，hit_count 累加（同问题反复弱命中 = 高优先级样本）。
 * 表不存在时静默降级（与其他闭环日志表一致），不影响主流程。
 */
const debug = require('debug')
const { db } = require('../db')

const log = debug('qa:badcase')

/**
 * 记录一条 badcase（幂等：question+reason 唯一，重复出现累加 hit_count）
 * @param {Object} params
 * @param {string} params.question - 用户问题（必填）
 * @param {string} params.reason - no_result | weak_hit | feedback_dislike
 * @param {string} [params.answer] - 当时的回答（可选）
 * @param {Object[]} [params.sources] - 当时的检索结果（取 bookTitle 汇总）
 * @param {string} [params.model] - 当时的模型
 * @param {string} [params.note] - 补充说明（如点踩原因）
 */
const recordBadcase = async ({ question, reason, answer = null, sources = [], model = null, note = '' }) => {
    if (!question || !question.trim()) return
    if (!['no_result', 'weak_hit', 'feedback_dislike'].includes(reason)) return
    try {
        const sourceBooks = [...new Set((sources || []).map(s => s.bookTitle).filter(Boolean))].slice(0, 10).join(' | ')
        const patch = {
            hit_count: db.raw('data.qa_badcase.hit_count + 1'),
            updated_at: db.raw('now()'),
        }
        if (answer) patch.answer = answer.slice(0, 8000)
        if (sourceBooks) patch.sources = sourceBooks
        if (model) patch.model = model
        if (note) patch.note = note.slice(0, 200)

        await db('qa_badcase')
            .insert({
                question: question.trim().slice(0, 500),
                reason,
                answer: answer ? answer.slice(0, 8000) : null,
                sources: sourceBooks || null,
                model: model || null,
                note: note ? note.slice(0, 200) : null,
            })
            .onConflict(['question', 'reason'])
            .merge(patch)
        log(`[badcase] 已记录: reason=${reason}, question="${question.trim().slice(0, 40)}..."`)
    } catch (e) {
        // 表不存在/连接异常时静默降级（学习样本丢失可接受，不阻塞主流程）
        log(`[badcase] 记录失败: ${e.message}`)
    }
}

module.exports = { recordBadcase }
