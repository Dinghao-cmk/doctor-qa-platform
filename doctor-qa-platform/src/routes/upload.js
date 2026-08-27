/**
 * routes/upload.js - 书籍上传入库 API
 *
 * POST /api/upload/preview  上传文件(multipart, field=file) → 解析预览（不落库）
 * POST /api/upload/confirm  { token } → 确认入库（清问答缓存）
 * POST /api/upload          { token } → 同 confirm（简化调用）
 */
const express = require('express')
const debug = require('debug')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const multer = require('multer')
const { ingestBook, ingestFromText, splitChapters, splitPassages, extractTitleFromText, SUPPORTED_EXTS } = require('../services/ingest')
const { genBookQuestions } = require('../services/questionGen')
const { runEmbeddingJob } = require('../services/embeddingJob')
const cache = require('../services/cache')
const config = require('../config')
const { db } = require('../db')

const log = debug('qa:upload')
const router = express.Router()

// 内存存储，上限 MAX_UPLOAD_MB（默认 500MB，env 可调）；defParamCharset=utf8 保证中文文件名正确解码（默认 latin1 会乱码）
// 大书支持：几千页文字版 PDF/TXT/MD 通常几十 MB，500MB 覆盖大体积医学书/报告合集；扫描版 PDF 无文字层在 parseFile 阶段明确报错
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.upload.maxMb * 1024 * 1024 },
    defParamCharset: 'utf8',
})

// multer 错误处理：文件超限给出友好中文提示（默认的 LIMIT_FILE_SIZE 错误太生硬）
const uploadErrorHandler = (err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
            error: `文件超过大小限制（最大 ${config.upload.maxMb}MB），请压缩后上传，或使用文字版 PDF/TXT`,
            code: 'FILE_TOO_LARGE',
        })
    }
    next(err)
}

/**
 * GET /api/upload/config - 上传限制配置（前端动态展示用）
 */
router.get('/upload/config', (req, res) => {
    res.json({ maxMb: config.upload.maxMb, maxBytes: config.upload.maxMb * 1024 * 1024 })
})

// 解析预览暂存（token → { buffer, filename, preview }），1 小时过期
const pending = new Map()
const PENDING_TTL = 60 * 60 * 1000

// 定期清理过期暂存
setInterval(() => {
    const now = Date.now()
    for (const [k, v] of pending) {
        if (now - v.time > PENDING_TTL) pending.delete(k)
    }
}, 10 * 60 * 1000)

/**
 * POST /api/upload/preview - 解析文件并返回预览
 */
router.post('/upload/preview', upload.single('file'), uploadErrorHandler, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请选择要上传的文件', code: 'NO_FILE' })
        }
        const { originalname: filename, size } = req.file
        const ext = (filename.split('.').pop() || '').toLowerCase()
        if (!SUPPORTED_EXTS.includes(ext)) {
            return res.status(400).json({
                error: `不支持的文件格式 .${ext}，请上传 TXT / MD / PDF`,
                code: 'UNSUPPORTED_TYPE',
            })
        }

        log(`[upload/preview] ${filename} (${(size / 1024).toFixed(1)}KB)`)

        // 解析 + 切分预览（不落库）
        const { parseFile } = require('../services/ingest')
        const text = await parseFile(req.file.buffer, filename)
        const chapters = splitChapters(text)
        const preview = chapters.map(ch => ({
            title: ch.title,
            chars: ch.content.trim().length,
            passages: splitPassages(ch.content).length,
        }))

        // 暂存待确认：缓存解析结果，confirm 直接复用（避免 PDF 二次解析）
        const token = crypto.randomBytes(8).toString('hex')
        pending.set(token, { text, filename, time: Date.now() })

        const bookTitle = (() => {
            const t = filename.replace(/\.[^.]+$/, '').trim()
            // 文件名无意义（纯数字/乱码/太短）时从内容前部提取标题
            if (!t || /^[\d\s]+$/.test(t) || t.length < 2) {
                return extractTitleFromText(text) || t || '未命名书籍'
            }
            return t
        })()
        res.json({
            token,
            fileName: filename,
            bookTitle,
            totalChars: text.length,
            chapterCount: chapters.length,
            totalPassages: preview.reduce((s, c) => s + c.passages, 0),
            chapters: preview.slice(0, 30), // 最多展示前 30 章
            ext,
        })
    } catch (error) {
        log(`[upload/preview] 失败: ${error.message}`)
        res.status(400).json({ error: error.message, code: 'PARSE_ERROR' })
    }
})

/**
 * 新书入库后：自动生成该书专项题库并追加到 scripts/eval/questions.json
 * 零成本规则生成，供评测脚本（run_eval --bookId）随时验证新书检索质量
 */
const appendBookQuestions = async (bookId, bookTitle) => {
    try {
        const qFile = path.join(__dirname, '../../scripts/eval/questions.json')
        if (!fs.existsSync(qFile)) return 0 // 题库文件不存在（未初始化评测），跳过

        // 收集新书整棵树
        const tree = new Set([bookId])
        let frontier = [bookId]
        while (frontier.length > 0) {
            const children = await db('rag_source_doc').select('id').whereIn('parent_id', frontier)
            const childIds = children.map(c => c.id).filter(id => !tree.has(id))
            if (childIds.length === 0) break
            childIds.forEach(id => tree.add(id))
            frontier = childIds
        }
        const docs = await db('rag_source_doc').select('id', 'title', 'level', 'parent_id').whereIn('id', [...tree])

        const newQs = genBookQuestions({ id: bookId, title: bookTitle }, docs)
        if (newQs.length === 0) return 0

        // 去重（避免同名书重复追加）后写入
        const data = JSON.parse(fs.readFileSync(qFile, 'utf8'))
        const existing = new Set(data.questions.map(q => q.question))
        let added = 0
        for (const nq of newQs) {
            if (existing.has(nq.question)) continue
            data.questions.push({
                id: `q${data.questions.length + 1}`,
                ...nq,
                score: { accuracy: null, completeness: null, citation: null, format: null },
                note: `新书专项（${bookTitle}）`,
            })
            existing.add(nq.question)
            added++
        }
        fs.writeFileSync(qFile, JSON.stringify(data, null, 2), 'utf8')
        log(`[upload] 已生成《${bookTitle}》专项题 ${added} 道，追加至题库`)
        return added
    } catch (e) {
        log(`[upload] 专项题库生成跳过: ${e.message}`)
        return 0
    }
}

/**
 * POST /api/upload/confirm - 确认入库
 */
router.post('/upload/confirm', async (req, res) => {
    try {
        const { token, title } = req.body || {}
        const item = pending.get(token)
        if (!item) {
            return res.status(400).json({ error: '预览已过期，请重新上传文件', code: 'PREVIEW_EXPIRED' })
        }
        pending.delete(token)

        const result = await ingestFromText(item.text, item.filename, title ? { title: String(title).trim().slice(0, 120) } : {})

        // 知识库已更新：清空问答缓存，避免旧答案
        cache.clear()
        log('[upload/confirm] 已清空问答缓存')

        // 新书专项题库：自动生成该书问题集，追加到评测题库
        const added = await appendBookQuestions(result.bookId, result.bookTitle)

        // 新书向量：后台异步为新增段落生成 embedding（不阻塞入库响应）
        // 未配置 embedding API 时 runEmbeddingJob 内部自动返回 0 条
        runEmbeddingJob({ concurrency: 4 })
            .then(r => log(`[upload] 新书向量后台生成完成: ${r.ok}/${r.total} 条`))
            .catch(e => log(`[upload] 新书向量后台生成失败: ${e.message}`))

        res.json({ success: true, ...result, evalQuestionsAdded: added })
    } catch (error) {
        log(`[upload/confirm] 失败: ${error.message}`)
        res.status(500).json({ error: error.message, code: 'INGEST_ERROR' })
    }
})

// 简化：单接口直接入库（不预览确认，测试用）
router.post('/upload', upload.single('file'), uploadErrorHandler, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: '请选择要上传的文件', code: 'NO_FILE' })
        const result = await ingestBook(req.file.buffer, req.file.originalname)
        cache.clear()
        res.json({ success: true, ...result })
    } catch (error) {
        log(`[upload] 失败: ${error.message}`)
        res.status(400).json({ error: error.message, code: 'INGEST_ERROR' })
    }
})

module.exports = router
