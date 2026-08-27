/**
 * cache.js - 简单的内存问答缓存
 * 避免相同问题重复调 LLM，将 3~4s 响应降到毫秒级
 */
const debug = require('debug')
const log = debug('qa:cache')

const CACHE_TTL = 60 * 60 * 1000 // 1 小时
const MAX_ENTRIES = 200

const store = new Map()

/**
 * 缓存键标准化：去空格、去标点、统一小写
 */
const normalizeKey = (question) => {
    return question
        .trim()
        .replace(/[？，。、；：！？\s,.\;\:\!\?\(\)\[\]（）【】""''"]/g, '')
        .toLowerCase()
}

/**
 * 从缓存获取
 * @returns {Object|null} 命中的结果，过期或不存在返回 null
 */
const get = (question) => {
    const key = normalizeKey(question)
    const entry = store.get(key)
    if (!entry) return null

    if (Date.now() - entry.time > CACHE_TTL) {
        store.delete(key)
        log(`[expired] ${question.slice(0, 30)}...`)
        return null
    }

    log(`[hit] ${question.slice(0, 40)}... → ${Date.now() - entry.time}ms 前缓存`)
    return entry.data
}

/**
 * 写入缓存（超限时淘汰最旧条目）
 */
const set = (question, data) => {
    const key = normalizeKey(question)
    if (store.size >= MAX_ENTRIES) {
        const oldestKey = store.keys().next().value
        store.delete(oldestKey)
    }
    store.set(key, { data, time: Date.now() })
}

/**
 * 清空缓存（调试/手动刷新用）
 */
const clear = () => {
    store.clear()
    log('[cache cleared]')
}

/**
 * 缓存统计
 */
const stats = () => ({
    size: store.size,
    max: MAX_ENTRIES,
    ttl: `${CACHE_TTL / 60000}min`,
})

// 定期清理过期条目（每分钟一次），防止过期缓存堆积占用内存
setInterval(() => {
    const now = Date.now()
    let expired = 0
    for (const [key, entry] of store) {
        if (now - entry.time > CACHE_TTL) {
            store.delete(key)
            expired++
        }
    }
    if (expired > 0) log(`[cleanup] 清理过期缓存 ${expired} 条，剩余 ${store.size} 条`)
}, 60 * 1000)

module.exports = { get, set, clear, stats }
