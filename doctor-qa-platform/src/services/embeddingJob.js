/**
 * embeddingJob.js - 批量向量生成任务（并发池 + 限流重试 + 增量）
 *
 * 使用场景：
 * - 新书入库后自动触发（upload/confirm 钩子，后台异步）
 * - 界面"为全部段落生成向量"按钮（rebuild 接口）
 *
 * 增量设计：只处理 embedding 为 NULL 的启用段落，幂等可重复调用
 * 并发设计：默认 4 并发（硅基流动限流下安全值），429/5xx 指数退避重试
 */
const debug = require('debug')
const { db } = require('../db')
const { generateEmbedding } = require('./embedding')

const log = debug('qa:embedding-job')

/** 限流重试：失败退避后重试（1s/3s/9s），最多 4 次 */
const embedWithRetry = async (text, attempt = 1) => {
    const vec = await generateEmbedding(text)
    if (vec && vec.length > 0) return vec
    if (attempt < 4) {
        const wait = 1000 * Math.pow(3, attempt - 1)
        await new Promise(r => setTimeout(r, wait))
        return embedWithRetry(text, attempt + 1)
    }
    return null
}

/**
 * 批量生成向量（只处理无向量的启用段落）
 * @param {Object} [opts]
 * @param {number} [opts.concurrency] - 并发数（默认 4，硅基流动限流下建议 2-6）
 * @param {Function} [opts.onProgress] - (done, total, ok, failed) => void
 * @returns {Promise<{total, ok, failed, skipped, durationMs}>}
 */
const runEmbeddingJob = async ({ concurrency = 4, onProgress } = {}) => {
    const rows = await db('rag_passage')
        .select('id', 'content')
        .where('enabled', true)
        .whereNull('embedding') // 增量：只处理无向量的段落
    const total = rows.length
    if (total === 0) {
        log('[embeddingJob] 无待处理段落（全部已有向量）')
        return { total: 0, ok: 0, failed: 0, skipped: 0, durationMs: 0 }
    }

    let ok = 0
    let failed = 0
    let done = 0

    const worker = async () => {
        while (true) {
            const row = rows.pop() // JS 单线程，pop 安全
            if (!row) break
            const content = (row.content || '').trim()
            if (content.length < 4) { done++; continue } // 过短段落跳过
            const vec = await embedWithRetry(content.slice(0, 500))
            if (vec && vec.length > 0) {
                await db('rag_passage').where('id', row.id).update({ embedding: JSON.stringify(vec) })
                ok++
            } else {
                failed++
            }
            done++
            if (onProgress) onProgress(done, total, ok, failed)
        }
    }

    const start = Date.now()
    await Promise.all(Array.from({ length: concurrency }, worker))
    const durationMs = Date.now() - start
    log(`[embeddingJob] 完成: 共${total} 成功${ok} 失败${failed} 耗时${(durationMs / 1000).toFixed(1)}s (并发${concurrency})`)
    return { total, ok, failed, skipped: total - ok - failed, durationMs }
}

module.exports = { runEmbeddingJob }
