/**
 * ragKnexfile.js
 *
 * RAG 知识库专用 Knex 连接（与主 ZK 库不同的 PG 实例）
 * 存放 rag_verify / rag_source_doc / rag_passage / rag_rule_doc_map 等表
 * 连接串由 RAG_DB_CONN_STR 环境变量提供；未配置时回退到 ZK_DB_CONN_STR
 */
const knexLib = require('knex')
const debug = require('debug')
const { RAG_DB_CONN_STR } = require('../constant')

const log = debug('rag-knexfile')

const ragKnex = knexLib({
    client: 'pg',
    connection: RAG_DB_CONN_STR,
    // 设置 search_path 到 data schema，这样查询时可以不写 data. 前缀
    searchPath: ['data', 'public'],
    pool: {
        min: 0,
        max: 10, // RAG 库查询频率低于主库，连接池可以小一些
    },
})

module.exports = ragKnex

if (require.main === module) {
    debug.enable('*')
    log({ RAG_DB_CONN_STR: RAG_DB_CONN_STR.replace(/\/\/.*@/, '//***@') })
    ragKnex.raw('select count(*) from data.rag_verify').then(res => console.log('rag_verify count:', res.rows[0].count))
}
