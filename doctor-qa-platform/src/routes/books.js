/**
 * routes/books.js - 书籍管理 API
 *
 * GET  /api/books/manage      书籍列表（含章节数/段落数/状态/上传时间）
 * POST /api/books/:id/disable 禁用书籍（递归禁用书→章→节及其段落，并清问答缓存）
 * POST /api/books/:id/enable  启用书籍（递归启用整棵树）
 */
const express = require('express')
const debug = require('debug')
const { db } = require('../db')
const cache = require('../services/cache')

const log = debug('qa:books')
const router = express.Router()

/**
 * 递归收集一棵树的 doc id（从根节点向下）
 */
const collectTree = async (rootIds) => {
    const treeIds = new Set(rootIds)
    let frontier = rootIds
    while (frontier.length > 0) {
        const children = await db('rag_source_doc').select('id').whereIn('parent_id', frontier)
        const childIds = children.map(c => c.id).filter(id => !treeIds.has(id))
        if (childIds.length === 0) break
        childIds.forEach(id => treeIds.add(id))
        frontier = childIds
    }
    return [...treeIds]
}

/**
 * GET /api/books/manage - 书籍管理列表
 */
router.get('/books/manage', async (req, res) => {
    try {
        const books = await db('rag_source_doc')
            .select('id', 'title', 'level', 'enabled', 'created_at')
            .where('level', 0)
            .orderBy('id')

        // 统计每本书的章节数和段落数
        const result = []
        for (const b of books) {
            const treeIds = await collectTree([b.id])
            const childCount = treeIds.length - 1
            const passageRow = await db('rag_passage')
                .whereIn('doc_id', treeIds)
                .andWhere('enabled', true)
                .count('* as n')
                .first()
            result.push({
                id: b.id,
                title: b.title,
                enabled: !!b.enabled,
                chapterCount: childCount,
                passageCount: Number(passageRow?.n || 0),
                createdAt: b.created_at,
            })
        }
        res.json({ books: result })
    } catch (error) {
        log(`[books/manage] 失败: ${error.message}`)
        res.status(500).json({ error: '获取书籍列表失败' })
    }
})

/**
 * GET /api/books/structure - PageIndex 全量结构（书→章→节→段落）
 * 供前端「PageIndex 索引」面板展示知识库结构，证明索引体系存在
 */
router.get('/books/structure', async (req, res) => {
    try {
        const nodes = await db('rag_source_doc')
            .select('id', 'title', 'level', 'parent_id', 'page_no', 'enabled')
            .where('enabled', true)
            .orderBy('id')
        const passages = await db('rag_passage')
            .select('id', 'doc_id', 'section_path', 'page_no', 'content')
            .where('enabled', true)
            .orderBy('id')
        // 段落按 doc_id 分组，挂在节点上
        const byDoc = {}
        for (const p of passages) {
            ;(byDoc[p.doc_id] = byDoc[p.doc_id] || []).push({
                id: p.id,
                sectionPath: p.section_path,
                pageNo: p.page_no,
                content: p.content,
            })
        }
        const tree = nodes.map(n => ({
            id: n.id,
            title: n.title,
            level: n.level,
            parentId: n.parent_id,
            pageNo: n.page_no,
            enabled: !!n.enabled,
            passages: byDoc[n.id] || [],
        }))
        res.json({
            stats: {
                books: nodes.filter(n => n.level === 0).length,
                chapters: nodes.filter(n => n.level === 1).length,
                sections: nodes.filter(n => n.level === 2).length,
                passages: passages.length,
            },
            tree,
        })
    } catch (error) {
        log(`[books/structure] 失败: ${error.message}`)
        res.status(500).json({ error: '获取知识库结构失败', code: 'STRUCTURE_ERROR' })
    }
})

/**
 * POST /api/books/:id/disable - 禁用书籍（递归）
 */
router.post('/books/:id/disable', async (req, res) => {
    const bookId = parseInt(req.params.id, 10)
    if (!Number.isInteger(bookId)) {
        return res.status(400).json({ error: '无效的书籍 ID', code: 'INVALID_ID' })
    }
    try {
        const book = await db('rag_source_doc').select('id', 'title').where('id', bookId).first()
        if (!book) {
            return res.status(404).json({ error: `书籍 ID=${bookId} 不存在`, code: 'BOOK_NOT_FOUND' })
        }
        const treeIds = await collectTree([bookId])
        await db('rag_passage').whereIn('doc_id', treeIds).update({ enabled: false })
        await db('rag_source_doc').whereIn('id', treeIds).update({ enabled: false })
        cache.clear()
        log(`[books/disable] 《${book.title}》(id=${bookId}) 已禁用，含 ${treeIds.length} 个文档节点，缓存已清空`)
        res.json({ ok: true, bookId, title: book.title, disabledTreeIds: treeIds.length })
    } catch (error) {
        log(`[books/disable] 失败: ${error.message}`)
        res.status(500).json({ error: '禁用书籍失败', code: 'DISABLE_ERROR' })
    }
})

/**
 * POST /api/books/:id/enable - 启用书籍（递归）
 */
router.post('/books/:id/enable', async (req, res) => {
    const bookId = parseInt(req.params.id, 10)
    if (!Number.isInteger(bookId)) {
        return res.status(400).json({ error: '无效的书籍 ID', code: 'INVALID_ID' })
    }
    try {
        const book = await db('rag_source_doc').select('id', 'title').where('id', bookId).first()
        if (!book) {
            return res.status(404).json({ error: `书籍 ID=${bookId} 不存在`, code: 'BOOK_NOT_FOUND' })
        }
        const treeIds = await collectTree([bookId])
        await db('rag_source_doc').whereIn('id', treeIds).update({ enabled: true })
        await db('rag_passage').whereIn('doc_id', treeIds).update({ enabled: true })
        cache.clear()
        log(`[books/enable] 《${book.title}》(id=${bookId}) 已启用，含 ${treeIds.length} 个文档节点，缓存已清空`)
        res.json({ ok: true, bookId, title: book.title, enabledTreeIds: treeIds.length })
    } catch (error) {
        log(`[books/enable] 失败: ${error.message}`)
        res.status(500).json({ error: '启用书籍失败', code: 'ENABLE_ERROR' })
    }
})

/**
 * GET /api/books/whitelist - 权威书目白名单列表
 */
router.get('/books/whitelist', async (req, res) => {
    try {
        const rows = await db('rag_book_whitelist')
            .select('id', 'title', 'domain', 'publisher', 'year', 'book_type', 'note', 'enabled', 'created_at')
            .orderBy('domain')
            .orderBy('year', 'desc')
        res.json({ books: rows })
    } catch (error) {
        log(`[whitelist/list] 失败: ${error.message}`)
        res.status(500).json({ error: '获取书目白名单失败', code: 'WL_LIST_ERROR' })
    }
})

/**
 * POST /api/books/whitelist - 新增白名单书目
 */
router.post('/books/whitelist', async (req, res) => {
    try {
        const { title, domain, publisher, year, book_type, note } = req.body || {}
        if (!title || !title.trim()) {
            return res.status(400).json({ error: '书名不能为空', code: 'WL_TITLE_REQUIRED' })
        }
        const [id] = await db('rag_book_whitelist').insert({
            title: title.trim(),
            domain: (domain || '综合').trim(),
            publisher: (publisher || '').trim(),
            year: (year || '').toString().trim(),
            book_type: (book_type || '指南').trim(),
            note: (note || '').trim(),
            enabled: true,
            created_at: new Date(),
            updated_at: new Date(),
        }).returning('id')
        log(`[whitelist/add] 新增书目: ${title.trim()} (id=${id})`)
        res.json({ ok: true, id })
    } catch (error) {
        log(`[whitelist/add] 失败: ${error.message}`)
        res.status(500).json({ error: '新增书目失败', code: 'WL_ADD_ERROR' })
    }
})

/**
 * PUT /api/books/whitelist/:id - 修改白名单书目
 */
router.put('/books/whitelist/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10)
        if (!id) return res.status(400).json({ error: '无效的 ID', code: 'WL_ID_INVALID' })
        const { title, domain, publisher, year, book_type, note, enabled } = req.body || {}
        const patch = { updated_at: new Date() }
        if (title !== undefined) patch.title = title.trim()
        if (domain !== undefined) patch.domain = domain.trim()
        if (publisher !== undefined) patch.publisher = (publisher || '').trim()
        if (year !== undefined) patch.year = (year || '').toString().trim()
        if (book_type !== undefined) patch.book_type = (book_type || '').trim()
        if (note !== undefined) patch.note = (note || '').trim()
        if (enabled !== undefined) patch.enabled = !!enabled
        const affected = await db('rag_book_whitelist').where('id', id).update(patch)
        if (!affected) return res.status(404).json({ error: '书目不存在', code: 'WL_NOT_FOUND' })
        res.json({ ok: true, id })
    } catch (error) {
        log(`[whitelist/update] 失败: ${error.message}`)
        res.status(500).json({ error: '修改书目失败', code: 'WL_UPDATE_ERROR' })
    }
})

/**
 * DELETE /api/books/whitelist/:id - 删除白名单书目
 */
router.delete('/books/whitelist/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10)
        if (!id) return res.status(400).json({ error: '无效的 ID', code: 'WL_ID_INVALID' })
        const affected = await db('rag_book_whitelist').where('id', id).delete()
        if (!affected) return res.status(404).json({ error: '书目不存在', code: 'WL_NOT_FOUND' })
        res.json({ ok: true, id })
    } catch (error) {
        log(`[whitelist/delete] 失败: ${error.message}`)
        res.status(500).json({ error: '删除书目失败', code: 'WL_DELETE_ERROR' })
    }
})

/**
 * GET /api/books/requests - 待补书目请求列表（未覆盖闭环）
 * ?status=pending|done|ignored|all（默认 pending）
 */
router.get('/books/requests', async (req, res) => {
    try {
        const status = req.query.status || 'pending'
        const q = db('rag_book_request_log').select('id', 'question', 'domain', 'hit_count', 'status', 'note', 'book_suggestions', 'created_at', 'updated_at')
        if (status !== 'all') q.where('status', status)
        const rows = await q.orderBy('hit_count', 'desc').orderBy('created_at', 'desc').limit(200)
        res.json({ requests: rows })
    } catch (error) {
        log(`[requests/list] 失败: ${error.message}`)
        res.status(500).json({ error: '获取待补书目失败', code: 'REQ_LIST_ERROR' })
    }
})

/**
 * PUT /api/books/requests/:id - 标记处理/忽略待补请求
 * body: { status: 'done'|'ignored', note?: string }
 */
router.put('/books/requests/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10)
        const { status, note } = req.body || {}
        if (!id) return res.status(400).json({ error: '无效的 ID', code: 'REQ_ID_INVALID' })
        if (!['pending', 'done', 'ignored'].includes(status)) return res.status(400).json({ error: '无效的状态', code: 'REQ_STATUS_INVALID' })
        const patch = { status, updated_at: db.raw('now()') }
        if (note !== undefined) patch.note = String(note).slice(0, 200)
        const affected = await db('rag_book_request_log').where('id', id).update(patch)
        if (!affected) return res.status(404).json({ error: '记录不存在', code: 'REQ_NOT_FOUND' })
        res.json({ ok: true, id })
    } catch (error) {
        log(`[requests/update] 失败: ${error.message}`)
        res.status(500).json({ error: '更新待补书目失败', code: 'REQ_UPDATE_ERROR' })
    }
})

module.exports = router
