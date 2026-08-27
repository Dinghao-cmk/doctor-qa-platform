/**
 * server.js - 医学知识问答平台 服务入口
 *
 * 启动方式:
 *   node src/server.js
 *   或（开发模式，自动重启）:
 *   npm run dev
 *
 * 环境变量:
 *   参见 .env.example
 */
const express = require('express')
const cors = require('cors')
const debug = require('debug')
const config = require('./config')
const { checkConnection, db } = require('./db')
const askRouter = require('./routes/ask')
const uploadRouter = require('./routes/upload')
const feedbackRouter = require('./routes/feedback')
const booksRouter = require('./routes/books')
const settingsRouter = require('./routes/settings')

// 启用调试日志（生产环境可通过 DEBUG=qa:* 开启）
if (!process.env.DEBUG) {
    debug.enable('qa:*')
}

const log = debug('qa:server')
const app = express()

// ── 中间件 ──────────────────────────────────────────────
app.use(cors())
app.use(express.json({ limit: '1mb' }))

// 静态文件（前端页面）
app.use(express.static('public'))

// 请求日志
app.use((req, res, next) => {
    const start = Date.now()
    res.on('finish', () => {
        log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`)
    })
    next()
})

// ── 路由 ──────────────────────────────────────────────
app.use('/api', askRouter)
app.use('/api', uploadRouter)
app.use('/api', feedbackRouter)
app.use('/api', booksRouter)
app.use('/api', settingsRouter)

// 根路径 - 服务信息
app.get('/', (req, res) => {
    res.json({
        service: '医学知识问答平台',
        version: '1.0.0',
        description: '基于 PageIndex 医学知识库，为临床医生提供即时问答服务',
        endpoints: {
            'POST /api/ask': '医生提问（主接口）',
            'GET /api/health': '健康检查',
            'GET /api/books': '知识库书籍列表',
        },
    })
})

// 404
app.use((req, res) => {
    res.status(404).json({ error: '接口不存在', path: req.path })
})

// 全局错误处理
app.use((err, req, res, next) => {
    console.error(`[QA平台] 未捕获异常: ${err.message}`)
    res.status(500).json({ error: '服务内部错误' })
})

// ── 启动 ──────────────────────────────────────────────
const start = async () => {
    console.log('╔══════════════════════════════════════════╗')
    console.log('║     医学知识问答平台 启动中...            ║')
    console.log('╚══════════════════════════════════════════╝')

    // 检查数据库连接
    const dbOk = await checkConnection()
    if (!dbOk) {
        console.error('❌ 数据库连接失败，请检查 RAG_DB_CONN_STR 配置')
        console.error('   当前连接串:', config.ragDbConnStr.replace(/\/\/.*@/, '//***@'))
        process.exit(1)
    }
    console.log('✅ 数据库连接正常')

    // 启动 HTTP 服务
    app.listen(config.port, () => {
        console.log(`✅ 服务已启动: http://localhost:${config.port}`)
        console.log(`   前端页面: http://localhost:${config.port}/ (直接浏览器打开)`)
        console.log(`   问答接口: POST http://localhost:${config.port}/api/ask`)
        console.log(`   健康检查: GET  http://localhost:${config.port}/api/health`)
        console.log('')
        console.log('   调用示例:')
        console.log(`   curl -X POST http://localhost:${config.port}/api/ask \\`)
        console.log('     -H "Content-Type: application/json" \\')
        console.log('     -d \'{"question": "高血压诊断标准是什么？"}\'')
    })
}

// 优雅退出
process.on('SIGINT', async () => {
    console.log('\n正在关闭服务...')
    await db.destroy()
    process.exit(0)
})

process.on('SIGTERM', async () => {
    await db.destroy()
    process.exit(0)
})

start().catch((err) => {
    console.error(`启动失败: ${err.message}`)
    process.exit(1)
})
