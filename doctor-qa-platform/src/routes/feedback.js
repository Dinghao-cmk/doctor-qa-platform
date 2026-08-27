/**
 * routes/feedback.js - 回答质量反馈 API
 *
 * POST /api/feedback  提交回答反馈（点赞/点踩 + 原因）
 * GET  /api/feedback/stats  反馈统计（调试/运营用）
 *
 * 用途：收集医生对回答质量的真实评价，驱动模型/prompt/检索迭代
 */
const express = require('express')
const debug = require('debug')
const { db } = require('../db')
const { recordBadcase } = require('../services/badcase')

const log = debug('qa:feedback')
const router = express.Router()

/**
 * POST /api/feedback
 * 请求体: {
 *   "question": "高血压诊断标准是什么？",   // 必填
 *   "answer": "...",                        // 可选（回答内容，可能很长）
 *   "rating": 1,                            // 必填 1=赞 -1=踩
 *   "reason": "回答不准确",                  // 点踩时建议填写
 *   "model": "deepseek-v4-flash",           // 可选
 *   "promptVersion": "v2",                  // 可选
 *   "sourceBooks": ["内科学第10版"],          // 可选（来源书列表）
 *   "durationMs": 3500                      // 可选（耗时）
 * }
 */
router.post('/feedback', async (req, res) => {
    const { question, answer, rating, reason, model, promptVersion, sourceBooks, durationMs } = req.body

    // 参数校验
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
        return res.status(400).json({ error: '缺少问题内容', code: 'INVALID_QUESTION' })
    }
    if (rating !== 1 && rating !== -1) {
        return res.status(400).json({ error: 'rating 必须为 1（赞）或 -1（踩）', code: 'INVALID_RATING' })
    }

    try {
        const result = await db('qa_feedback').insert({
            question: question.trim().slice(0, 500),
            answer: answer ? answer.slice(0, 8000) : null,
            rating,
            reason: reason ? reason.trim().slice(0, 500) : null,
            model: model || null,
            prompt_version: promptVersion || null,
            source_books: Array.isArray(sourceBooks) && sourceBooks.length > 0
                ? sourceBooks.slice(0, 20).join(' | ')
                : null,
            duration_ms: Number.isInteger(durationMs) ? durationMs : null,
        }).returning('id')

        // 兼容两种 returning 返回形态：数字数组 [3] 或对象数组 [{id: 3}]
        const first = Array.isArray(result) ? result[0] : result
        const id = first != null ? (typeof first === 'object' ? first.id : first) : null
        log(`[feedback] 已记录: id=${id}, rating=${rating}, reason="${reason ? reason.slice(0, 50) : ''}", model=${model}`)
        // 学习闭环：点踩即检索/回答弱质量样本，同步入 badcase 池（供扩充题库/检索调参）
        if (rating === -1) {
            await recordBadcase({
                question: question.trim(),
                reason: 'feedback_dislike',
                answer,
                sources: (sourceBooks || []).map(title => ({ bookTitle: title })),
                model,
                note: reason ? `用户点踩：${reason}` : '用户点踩',
            })
        }
        res.json({ ok: true, id })
    } catch (error) {
        log(`[feedback] 记录失败: ${error.message}`)
        res.status(500).json({ error: '反馈保存失败，请稍后重试', code: 'FEEDBACK_SAVE_ERROR' })
    }
})

/**
 * GET /api/feedback/stats - 反馈统计（运营/调试用）
 */
router.get('/feedback/stats', async (req, res) => {
    try {
        const rows = await db('qa_feedback')
            .select(
                db.raw("COUNT(*) FILTER (WHERE rating = 1) AS likes"),
                db.raw("COUNT(*) FILTER (WHERE rating = -1) AS dislikes"),
                db.raw("COUNT(*) FILTER (WHERE rating = -1 AND reason IS NOT NULL AND reason != '') AS dislikes_with_reason")
            )
            .first()

        const recent = await db('qa_feedback')
            .select('id', 'question', 'rating', 'reason', 'model', 'prompt_version', 'source_books', 'created_at')
            .orderBy('id', 'desc')
            .limit(10)

        res.json({ ...rows, recent })
    } catch (error) {
        log(`[feedback] 统计失败: ${error.message}`)
        res.status(500).json({ error: '获取反馈统计失败' })
    }
})

module.exports = router
