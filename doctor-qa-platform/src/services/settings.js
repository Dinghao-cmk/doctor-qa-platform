/**
 * settings.js - 界面化配置服务
 *
 * 配置存储于数据库 qa_settings 表（key/value），界面可读写、动态生效：
 * - DB 值优先，未配置的项回退到 .env 默认值
 * - 内存缓存 + 60s TTL，set 时主动失效，改完立即生效无需重启
 *
 * 配置项（key）：
 *   llm_api_url        LLM API 地址
 *   llm_api_key        LLM API Key
 *   llm_model          快模型名
 *   llm_strong_model   强模型名
 *   llm_fallback       知识库未命中兜底开关（true/false）
 *   embedding_api_url  Embedding API 地址
 *   embedding_api_key  Embedding API Key
 *   embedding_model    Embedding 模型名
 */
const debug = require('debug')
const { db } = require('../db')
const config = require('../config')

const log = debug('qa:settings')

const CACHE_TTL = 60 * 1000 // 缓存 60 秒
let cache = null // { data: Map, time: number }

const getFromDb = async () => {
    const rows = await db('qa_settings').select('key', 'value')
    const map = new Map()
    for (const r of rows) map.set(r.key, r.value)
    return map
}

/** 读取全部配置（DB 优先 + env 兜底），带缓存 */
const getAll = async () => {
    const now = Date.now()
    if (cache && now - cache.time < CACHE_TTL) return cache.data
    try {
        const dbMap = await getFromDb()
        cache = { data: dbMap, time: now }
        return dbMap
    } catch (error) {
        log(`读取配置失败（表可能不存在），使用环境变量: ${error.message}`)
        return new Map()
    }
}

/** 立即失效缓存（配置更新后调用） */
const invalidate = () => { cache = null }

/** 设置配置项（空字符串 = 删除该项，恢复 env 默认） */
const set = async (key, value) => {
    if (typeof value === 'boolean') value = value ? 'true' : 'false'
    if (value === null || value === undefined) return
    const v = String(value).trim()
    if (v === '') {
        await db('qa_settings').where('key', key).del()
    } else {
        await db('qa_settings')
            .insert({ key, value: v })
            .onConflict('key')
            .merge({ value: v, updated_at: new Date() })
    }
    invalidate()
}

/** 读取单个配置项（DB 优先，env 兜底） */
const get = async (key, envDefault = '') => {
    const map = await getAll()
    const v = map.get(key)
    if (v !== undefined && v !== null && v !== '') return v
    return envDefault
}

/** LLM 配置（合并 DB + env） */
const getLLM = async () => {
    const [apiUrl, apiKey, model, strongModel, fallback] = await Promise.all([
        get('llm_api_url', config.llm.apiUrl),
        get('llm_api_key', config.llm.apiKey),
        get('llm_model', config.llm.model),
        get('llm_strong_model', config.llm.strongModel),
        get('llm_fallback', String(config.llm.fallback)),
    ])
    return {
        apiUrl,
        apiKey,
        model,
        strongModel,
        fallback: fallback !== 'false',
    }
}

/** 本地模型配置（对比实验 D 组用；DB 优先 + env 兑底） */
const getLocalLLM = async () => {
    const [apiUrl, apiKey, model] = await Promise.all([
        get('llm_local_api_url', process.env.LOCAL_LLM_API_URL || 'http://localhost:11434/v1/chat/completions'),
        get('llm_local_api_key', process.env.LOCAL_LLM_API_KEY || 'ollama'),
        get('llm_local_model', process.env.LOCAL_LLM_MODEL || 'qwen2.5:7b-instruct'),
    ])
    return { apiUrl, apiKey, model }
}

/** 联网搜索配置（未收录问题时联网检索回答；DB 优先 + env 兜底） */
const getWebSearch = async () => {
    const [enabled, apiKey, apiUrl, domains, threshold] = await Promise.all([
        get('web_search_enabled', 'false'),
        get('web_search_api_key', process.env.WEB_SEARCH_API_KEY || ''),
        get('web_search_api_url', process.env.WEB_SEARCH_API_URL || 'https://google.serper.dev/search'),
        get('web_search_domains', process.env.WEB_SEARCH_DOMAINS || ''),
        get('web_search_threshold', '0.5'),
    ])
    return {
        enabled: enabled === 'true' && !!apiKey,
        apiKey,
        apiUrl,
        domains: String(domains).split(',').map(s => s.trim()).filter(Boolean),
        threshold: parseFloat(threshold) || 0.5,
    }
}

/** Embedding 配置（合并 DB + env） */
const getEmbedding = async () => {
    const [apiUrl, apiKey, model] = await Promise.all([
        get('embedding_api_url', process.env.EMBEDDING_API_URL || ''),
        get('embedding_api_key', process.env.EMBEDDING_API_KEY || ''),
        get('embedding_model', process.env.EMBEDDING_MODEL || 'BAAI/bge-large-zh-v1.5'),
    ])
    return { apiUrl, apiKey, model, enabled: !!apiUrl }
}

/**
 * 检索融合配置（RRF 权重 / k / 向量降级阈值；DB 优先 + env 兜底）
 * DB 存储格式：search_fusion = JSON 字符串，如
 * {"rrfK":60,"weights":{"vector":1,"keyword":1,"title":1,"path":0.8},"vectorFallback":0.4}
 * 未配置或解析失败的字段逐个回退到 env/config 默认值，保证配置永远完整可用
 */
const getSearchFusion = async () => {
    const dbValue = await get('search_fusion', '')
    const cfg = config.search.fusion
    const parsed = {} // 从 DB JSON 中解析出的有效字段
    if (dbValue) {
        try {
            const obj = JSON.parse(dbValue)
            if (obj && typeof obj === 'object') {
                if (Number.isFinite(obj.rrfK) && obj.rrfK > 0) parsed.rrfK = obj.rrfK
                if (Number.isFinite(obj.vectorFallback) && obj.vectorFallback > 0) parsed.vectorFallback = obj.vectorFallback
                if (obj.weights && typeof obj.weights === 'object') {
                    parsed.weights = {}
                    for (const [k, v] of Object.entries(obj.weights)) {
                        if (Number.isFinite(v) && v >= 0) parsed.weights[k] = v
                    }
                }
            }
        } catch (e) {
            log(`search_fusion 配置解析失败，回退默认: ${e.message}`)
        }
    }
    return {
        rrfK: parsed.rrfK ?? cfg.rrfK,
        weights: { ...cfg.weights, ...(parsed.weights || {}) },
        vectorFallback: parsed.vectorFallback ?? cfg.vectorFallback,
    }
}

/** 对外返回的配置快照（API Key 脱敏） */
const getPublic = async () => {
    const [llm, emb, web, local] = await Promise.all([getLLM(), getEmbedding(), getWebSearch(), getLocalLLM()])
    const mask = (v) => (v ? v.slice(0, 6) + '****' + v.slice(-4) : '')
    return {
        llm: {
            apiUrl: llm.apiUrl,
            apiKey: mask(llm.apiKey),
            hasKey: !!llm.apiKey,
            model: llm.model,
            strongModel: llm.strongModel,
            fallback: llm.fallback,
        },
        embedding: {
            apiUrl: emb.apiUrl,
            apiKey: mask(emb.apiKey),
            hasKey: !!emb.apiKey,
            model: emb.model,
            enabled: emb.enabled,
        },
        webSearch: {
            enabled: web.enabled,
            apiUrl: web.apiUrl,
            apiKey: mask(web.apiKey),
            hasKey: !!web.apiKey,
            domains: web.domains.join(','),
            threshold: web.threshold,
        },
        localLlm: {
            apiUrl: local.apiUrl,
            apiKey: mask(local.apiKey),
            model: local.model,
        },
    }
}

module.exports = { getAll, get, set, invalidate, getLLM, getLocalLLM, getEmbedding, getPublic, getWebSearch, getSearchFusion }
