// ------------------------------------------------------------------------------
// 文件名称: ragGraph.js
// 主要功能: RAG 知识图谱检索 — 支持 GraphRAG 和 LightRAG 两种后端
// 设计要点:
//   - graphSearch: 调用远程 RAG 服务 /rag_graph_search 端点（原 GraphRAG）
//   - lightragSearch: 调用 /rag_lightrag_search 端点（LightRAG，推荐）
//   - 返回格式与 ragVerifySearch / pageIndexSearch 一致
//   - 任意异常时返回 null，调用方据此降级到扁平 ragVerifySearch
// ------------------------------------------------------------------------------

const debug = require('debug')
const agent = require('superagent')
const crypto = require('crypto')
const { RAG_SERVER_ROOT } = require('../constant')

const log = debug('qc:rag-graph')

// ── 远程接口地址 ─────────────────────────────────────────────
const RAG_GRAPH_SEARCH_URL = RAG_SERVER_ROOT + '/rag_graph_search'
const RAG_LIGHTRAG_SEARCH_URL = RAG_SERVER_ROOT + '/rag_lightrag_search'

/**
 * graphSearch: 知识图谱检索
 * 通过实体抽取 → 图遍历 → 社区摘要 → 关联段落，实现跨文档关联推理
 *
 * @param {Object} options
 * @param {string} options.queryText - 缺陷描述/查询文本
 * @param {string} options.noteQcCode - 质控编码
 * @param {string[]} [options.entityTypes] - 限定实体类型（如 ['drug', 'disease']），null 表示不限
 * @param {number} [options.maxHops=2] - 图遍历跳数（1=直接邻居, 2=两跳内）
 * @param {number} [options.similarityThreshold=0.5] - 实体匹配相似度阈值
 * @param {number} [options.limitCount=3] - 返回条数上限
 * @param {number[]} [options.docIds] - PageIndex 路由命中的文档 ID，用于缩小 GraphRAG 搜索范围
 * @returns {Promise<any[]|null>} 检索结果数组，失败时返回 null
 */
const graphSearch = async ({
    queryText,
    noteQcCode,
    entityTypes = null,
    maxHops = 2,
    similarityThreshold = 0.5,
    limitCount = 3,
    docIds = null,
}) => {
    try {
        log(`[graph search] qc=${noteQcCode}, hops=${maxHops}, types=${entityTypes || 'all'}, docs=${docIds ? docIds.length : 'all'}`)
        const response = await agent
            .post(RAG_GRAPH_SEARCH_URL)
            .send({
                query_text: queryText,
                note_qc_code: noteQcCode,
                entity_types: entityTypes,
                max_hops: maxHops,
                similarity_threshold: similarityThreshold,
                limit_count: limitCount,
                doc_ids: docIds,
            })
            .set('Content-Type', 'application/json')
            .set('X-Request-ID', crypto.randomUUID().slice(0, 12))

        const results = response.body
        log(`[graph search] 返回 ${Array.isArray(results) ? results.length : 0} 条结果`)
        return results
    } catch (error) {
        log(`[graph search error] ${error.message}`)
        if (error.response) {
            log(`[graph search] 服务端状态码: ${error.response.status}`)
        }
        return null
    }
}

/**
 * lightragSearch: LightRAG 知识图谱检索（推荐）
 * 比 GraphRAG 更轻量，支持 hybrid/local/global 三种检索模式
 *
 * @param {Object} options
 * @param {string} options.queryText - 缺陷描述/查询文本
 * @param {string} options.noteQcCode - 质控编码
 * @param {string} [options.mode='hybrid'] - 检索模式: naive/local/global/hybrid
 * @param {number} [options.limitCount=3] - 返回条数上限
 * @param {number[]} [options.docIds] - PageIndex 路由命中的文档 ID，用于缩小搜索范围
 * @returns {Promise<any[]|null>} 检索结果数组，失败时返回 null
 */
const lightragSearch = async ({
    queryText,
    noteQcCode,
    mode = 'hybrid',
    limitCount = 3,
    docIds = null,
}) => {
    try {
        log(`[lightrag search] qc=${noteQcCode}, mode=${mode}, docs=${docIds ? docIds.length : 'all'}`)
        const response = await agent
            .post(RAG_LIGHTRAG_SEARCH_URL)
            .send({
                query_text: queryText,
                note_qc_code: noteQcCode,
                mode: mode,
                limit_count: limitCount,
                doc_ids: docIds,
            })
            .set('Content-Type', 'application/json')
            .set('X-Request-ID', crypto.randomUUID().slice(0, 12))

        const results = response.body
        log(`[lightrag search] 返回 ${Array.isArray(results) ? results.length : 0} 条结果`)
        return results
    } catch (error) {
        log(`[lightrag search error] ${error.message}`)
        if (error.response) {
            log(`[lightrag search] 服务端状态码: ${error.response.status}`)
        }
        return null
    }
}

module.exports = {
    graphSearch,
    lightragSearch,
}
