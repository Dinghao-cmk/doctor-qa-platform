/**
 * ingest.js - 书籍入库服务
 * 解析 TXT/MD/PDF → 章节层级 → 段落切分 → 写入 rag_source_doc + rag_passage
 * 本平台为纯关键词搜索（无 embedding），段落 embedding 置 NULL 即可
 */
const debug = require('debug')
const crypto = require('crypto')
const { db } = require('../db')
const { segment } = require('./tokenizer')

const log = debug('qa:ingest')

// 支持的文件类型
const SUPPORTED_EXTS = ['txt', 'md', 'pdf']

/** 解析文件为纯文本 */
const parseFile = async (buffer, filename) => {
    const ext = (filename.split('.').pop() || '').toLowerCase()
    if (!SUPPORTED_EXTS.includes(ext)) {
        throw new Error(`不支持的文件格式 .${ext}，请上传 TXT / MD / PDF`)
    }
    let text = ''
    if (ext === 'txt' || ext === 'md') {
        text = buffer.toString('utf8')
    } else if (ext === 'pdf') {
        const pdfLib = require('pdf-parse')
        if (typeof pdfLib === 'function') {
            // v1 旧版：pdf(buffer) → { text }
            const res = await pdfLib(buffer)
            text = res.text || ''
        } else if (pdfLib.PDFParse) {
            // v2 新版：new PDFParse({ data: Uint8Array }).getText() → { text }
            const parser = new pdfLib.PDFParse({ data: new Uint8Array(buffer) })
            const result = await parser.getText()
            text = result.text || ''
        } else {
            throw new Error('pdf-parse 版本不受支持')
        }
        if (!text.trim()) {
            throw new Error('PDF 未提取到文本（可能是扫描件，无文字层，请上传文字版 PDF 或 TXT）')
        }
    }
    return text.trim()
}

/**
 * 按标题行切分章节
 * 识别：Markdown 标题（#/##/###）、中文"第X章/节/篇"、数字编号"1."、"一、"
 * @returns {Array<{title: string, content: string}>}
 */
const splitChapters = (text) => {
    const lines = text.split(/\r?\n/)
    const chapters = []
    let current = null

    const isHeading = (line) => {
        const t = line.trim()
        if (!t || t.length > 60) return null
        if (/^#{1,3}\s+\S/.test(t)) return t.replace(/^#{1,3}\s+/, '').trim()
        if (/^第[一二三四五六七八九十百千万0-9０-９]+[章节篇部分]\s*\S?/.test(t)) return t.trim()
        if (/^[一二三四五六七八九十]+、\S+/.test(t) && t.length <= 30) return t.trim()
        if (/^[0-9０-９]{1,3}[.．、]\s*\S+/.test(t) && t.length <= 30) return t.trim()
        return null
    }

    for (const line of lines) {
        const heading = isHeading(line)
        if (heading) {
            current = { title: heading, content: '' }
            chapters.push(current)
        } else if (current) {
            current.content += line + '\n'
        }
    }

    // 没有识别到标题：整本作为一个章节
    if (chapters.length === 0) {
        return [{ title: '正文', content: text }]
    }
    // 去掉空章节
    return chapters.filter(c => c.content.trim().length > 0)
}

/**
 * 章节内容切分为段落
 * 按空行分块，单块 >800 字时按句号/分号进一步切分
 */
const splitPassages = (content) => {
    const blocks = content
        .split(/\n\s*\n|\n{2,}/)
        .map(b => b.replace(/\s+/g, ' ').trim())
        .filter(b => b.length >= 20)

    const passages = []
    for (let block of blocks) {
        if (block.length <= 800) {
            passages.push(block)
            continue
        }
        // 长块按句子切分（句号/分号/问号后）
        const parts = block.split(/(?<=[。；;！？!?])\s*/).filter(p => p.trim().length > 0)
        let buf = ''
        for (const part of parts) {
            if (buf.length + part.length > 500 && buf.length >= 50) {
                passages.push(buf)
                buf = part
            } else {
                buf += part
            }
        }
        if (buf.trim().length >= 20) passages.push(buf)
    }
    return passages
}

/**
 * 从文本前部提取候选书名（文件名无意义时使用）：取前 200 字符中的首行非空短行
 */
const extractTitleFromText = (text) => {
    const head = text.slice(0, 2000)
    const lines = head.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0)
    for (const line of lines.slice(0, 5)) {
        if (line.length >= 2 && line.length <= 60 && !/^[\d\s.\-—|]+$/.test(line)) {
            return line.slice(0, 60)
        }
    }
    return null
}

/**
 * 解析并入库一本书（完整流程：解析文件 → 切分 → 写入）
 * @param {Buffer} buffer - 文件内容
 * @param {string} filename - 文件名（用作书名）
 * @param {Object} [meta] - { domain }
 * @returns {Promise<{bookId, bookTitle, chapterCount, passageCount}>}
 */
const ingestBook = async (buffer, filename, meta = {}) => {
    const text = await parseFile(buffer, filename)
    return ingestFromText(text, filename, meta)
}

/**
 * 用已解析文本入库（preview 已解析过时直接复用，避免重复解析 PDF）
 * @param {string} text - 已解析的纯文本
 * @param {string} filename - 文件名（用作书名）
 * @param {Object} [meta] - { domain }
 * @returns {Promise<{bookId, bookTitle, chapterCount, passageCount}>}
 */
const ingestFromText = async (text, filename, meta = {}) => {
    // 书名：meta.title 优先（前端可编辑），否则文件名去扩展名；文件名无意义（纯数字等）时尝试从内容提取
    let bookTitle = ''
    if (meta.title && meta.title.trim()) {
        bookTitle = meta.title.trim()
    } else {
        bookTitle = (filename.replace(/\.[^.]+$/, '') || '未命名书籍').trim()
        if (!bookTitle || /^[\d\s]+$/.test(bookTitle) || bookTitle.length < 2) {
            bookTitle = extractTitleFromText(text) || '未命名书籍'
        }
    }
    const chapters = splitChapters(text)
    if (chapters.length === 0) throw new Error('未解析到有效内容')

    const trx = await db.transaction()
    try {
        // 同名书籍已存在：递归禁用旧书整棵树（书→章→节）及其全部段落，避免子章节残留
        const oldBook = await trx('rag_source_doc')
            .where('title', bookTitle).andWhere('level', 0).andWhere('enabled', true).first()
        if (oldBook) {
            // 递归收集整棵树的 doc id
            const treeIds = new Set([oldBook.id])
            let frontier = [oldBook.id]
            while (frontier.length > 0) {
                const children = await trx('rag_source_doc').select('id').whereIn('parent_id', frontier)
                const childIds = children.map(c => c.id).filter(id => !treeIds.has(id))
                if (childIds.length === 0) break
                childIds.forEach(id => treeIds.add(id))
                frontier = childIds
            }
            const allIds = [...treeIds]
            // 禁用整棵树的段落
            await trx('rag_passage').whereIn('doc_id', allIds).update({ enabled: false })
            // 禁用整棵树的文档（书+章+节）
            await trx('rag_source_doc').whereIn('id', allIds).update({ enabled: false })
            log(`[ingest] 已禁用同名旧书《${bookTitle}》(id=${oldBook.id}, 含${allIds.length}个文档节点)`)
        }

        // 1. 建书（level 0）
        const [bookId] = await trx('rag_source_doc').insert({
            title: bookTitle,
            doc_type: 'book',
            domain: meta.domain || '医学',
            keywords: [],
            file_path: filename,
            level: 0,
            parent_id: null,
            node_path: `/${bookTitle}`,
            enabled: true,
            created_at: new Date(),
        }).returning('id')

        // 2. 批量建章节（单次 SQL，避免逐章多次往返）
        const chapterRows = chapters.map(ch => ({
            title: ch.title,
            doc_type: 'chapter',
            domain: meta.domain || '医学',
            keywords: [],
            file_path: filename,
            parent_id: bookId,
            level: 1,
            node_path: `/${bookTitle}/${ch.title}`,
            enabled: true,
            created_at: new Date(),
        }))
        const chapterIds = await trx('rag_source_doc').insert(chapterRows).returning('id')

        // 3. 批量写段落
        let passageCount = 0
        const passageRows = []
        for (let i = 0; i < chapters.length; i++) {
            const passages = splitPassages(chapters[i].content)
            if (passages.length === 0) continue
            for (const p of passages) {
                passageRows.push({
                    doc_id: chapterIds[i],
                    section_path: chapters[i].title,
                    page_no: null,
                    content: p,
                    content_terms: segment(p),
                    embedding: null,
                    content_hash: crypto.createHash('md5').update(p).digest('hex'),
                    enabled: true,
                    created_at: new Date(),
                })
            }
            passageCount += passages.length
        }
        if (passageRows.length > 0) {
            await trx.batchInsert('rag_passage', passageRows, 200)
        }

        await trx.commit()
        log(`[ingest] 《${bookTitle}》入库完成: ${chapters.length} 章, ${passageCount} 段`)
        return { bookId, bookTitle, chapterCount: chapters.length, passageCount }
    } catch (error) {
        await trx.rollback()
        log(`[ingest] 入库失败: ${error.message}`)
        throw error
    }
}

module.exports = { ingestBook, ingestFromText, parseFile, splitChapters, splitPassages, extractTitleFromText, SUPPORTED_EXTS }
