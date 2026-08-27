/**
 * db.js - RAG 知识库数据库连接（只读）
 * 复用 agent-qc-node 的 RAG PostgreSQL 实例
 */
const knexLib = require('knex')
const debug = require('debug')
const config = require('./config')

const log = debug('qa:db')

const db = knexLib({
    client: 'pg',
    connection: config.ragDbConnStr,
    searchPath: ['data', 'public'],
    pool: {
        min: 0,
        max: 5, // 问答平台连接池无需太大
    },
})

// 连接健康检查
const checkConnection = async () => {
    try {
        const res = await db.raw('SELECT current_database() AS db, current_user AS usr')
        const row = res.rows[0]
        log(`数据库连接成功: database=${row.db}, user=${row.usr}`)
        return true
    } catch (error) {
        console.error(`[QA平台] 数据库连接失败: ${error.message}`)
        return false
    }
}

module.exports = { db, checkConnection }
