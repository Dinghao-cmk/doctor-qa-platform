/**
 * embedding.js - 文本向量化服务
 * 双路径策略：
 *   1. 优先调用数据库内置 generate_embedding() 函数
 *   2. 若函数不可用，回退到外部 Embedding API（需配置 EMBEDDING_API_URL）
 *
 * 注意：DeepSeek 不提供 Embedding 服务，如不额外配置 Embedding API，
 * 向量搜索会自动降级为纯关键词搜索 + LLM 回答，体验不受影响。
 */
const debug = require('debug')
const superagent = require('superagent')
const config = require('../config')
const settings = require('./settings')
const { db } = require('../db')

const log = debug('qa:embedding')

// 标记数据库函数是否可用（首次调用时检测，避免每次都试错）
let dbFunctionAvailable = null

// 标记整体 embedding 能力是否可用（DB函数或外部API任一可用即可）
// 首次调用探测，确认不可用后后续请求直接短路返回 null，避免每次白跑
let embeddingAvailable = null

/**
 * 通过数据库函数生成 embedding
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
const embedViaDbFunction = async (text) => {
    try {
        const res = await db.raw('SELECT data.generate_embedding(?) AS vec', [text])
        const vec = res.rows[0]?.vec
        if (vec) {
            if (typeof vec === 'string') {
                return JSON.parse(vec)
            }
            return vec
        }
        return null
    } catch (error) {
        if (dbFunctionAvailable === null) {
            dbFunctionAvailable = false
            log(`数据库中 generate_embedding() 函数不可用，向量搜索降级为纯关键词搜索`)
        }
        return null
    }
}

// bge 系列模型官方查询指令前缀：查询侧编码需加前缀，段落侧不加
// 参考 BAAI/bge-large-zh-v1.5 文档（检索相关性显著提升）
const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：'

/**
 * 通过本地 Ollama embedding 生成向量（bge-m3，1024 维，与 bge-large-zh 兼容）
 * 本地路径优先：不依赖外网，断网也能向量检索
 * @returns {Promise<number[]|null>}
 */
const embedViaOllama = async (text, { isQuery = false } = {}) => {
    const localUrl = await settings.get('embedding_local_url', 'http://localhost:11434/api/embed')
    const localModel = await settings.get('embedding_local_model', 'bge-m3')
    try {
        const input = isQuery ? QUERY_INSTRUCTION + text : text
        const req = superagent
            .post(localUrl)
            .send({ model: localModel, input })
            .set('Content-Type', 'application/json')
            .timeout({ response: 30000 })
        const res = await req
        const embedding = res.body?.embeddings?.[0]
        if (embedding && Array.isArray(embedding)) {
            log(`Ollama本地向量成功, dim=${embedding.length}`)
            return embedding
        }
        log(`Ollama embed 返回格式异常: ${JSON.stringify(res.body).slice(0, 150)}`)
        return null
    } catch (error) {
        log(`Ollama embed 调用失败: ${error.message}`)
        return null
    }
}

/**
 * 通过外部 API 生成 embedding（OpenAI 兼容格式）
 * @param {string} text
 * @param {Object} [opts] - { isQuery: 查询侧文本加 bge 指令前缀 }
 * @returns {Promise<number[]|null>}
 */
const embedViaApi = async (text, { isQuery = false } = {}) => {
    // 界面化配置优先（settings 表），env 兜底
    const { apiUrl, apiKey, model } = await settings.getEmbedding()
    if (!apiUrl) {
        return null
    }

    try {
        // 查询侧加 bge 指令前缀，提升检索相关性；段落/文档侧保持原样
        const input = isQuery ? QUERY_INSTRUCTION + text : text
        const req = superagent
            .post(apiUrl)
            .send({
                model,
                input,
                encoding_format: 'float',
            })
            .set('Content-Type', 'application/json')

        if (apiKey) {
            req.set('Authorization', `Bearer ${apiKey}`)
        }

        const res = await req
        const embedding = res.body?.data?.[0]?.embedding
        if (embedding && Array.isArray(embedding)) {
            log(`API生成向量成功, dim=${embedding.length}`)
            return embedding
        }
        log(`API 返回格式异常: ${JSON.stringify(res.body).slice(0, 200)}`)
        return null
    } catch (error) {
        log(`Embedding API 调用失败: ${error.message}`)
        return null
    }
}

/**
 * 生成文本的向量嵌入（主入口）
 * @param {string} text - 待向量化的文本
 * @param {Object} [opts] - { isQuery: 是否为查询侧文本（加 bge 指令前缀） }
 * @returns {Promise<number[]|null>} 向量数组，失败返回 null
 */
const generateEmbedding = async (text, opts = {}) => {
    if (!text || text.trim().length === 0) return null

    // 已确认全部路径不可用（无 DB 函数 + 无外部 API），直接短路
    if (embeddingAvailable === false) return null

    // 路径 1：数据库函数（如果未确认不可用）
    if (dbFunctionAvailable !== false) {
        const vec = await embedViaDbFunction(text)
        if (vec) {
            dbFunctionAvailable = true
            embeddingAvailable = true
            log(`DB函数生成向量成功, dim=${vec.length}`)
            return vec
        }
    }

    // 路径 2：本地 Ollama embedding（bge-m3，不依赖外网）
    const localVec = await embedViaOllama(text, opts)
    if (localVec) {
        embeddingAvailable = true
        return localVec
    }

    // 路径 3：外部 API（如硅基流动）
    const vec = await embedViaApi(text, opts)
    if (vec) {
        embeddingAvailable = true
        return vec
    }

    // 两条路径均失败：仅当未配置外部 API 时永久短路；
    // 已配置 API 时不短路——失败可能是暂时性限流（429），下次调用继续尝试
    const { enabled: apiConfigured } = await settings.getEmbedding()
    if (!apiConfigured && embeddingAvailable === null) {
        embeddingAvailable = false
        log('[embedding] DB函数与外部API均不可用，后续向量搜索直接短路跳过')
    }
    return null
}

/**
 * 重置 embedding 能力探测状态（界面更新配置后调用，让新配置生效）
 */
const resetEmbeddingState = () => {
    dbFunctionAvailable = null
    embeddingAvailable = null
    log('[embedding] 配置已更新，重置可用性探测状态')
}

module.exports = { generateEmbedding, resetEmbeddingState }
