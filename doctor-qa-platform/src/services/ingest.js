/**
 * ingest.js - 书籍入库服务
 * 解析 TXT/MD/PDF → 章节树（书→章→节）→ 段落切分 → 写入 rag_source_doc + rag_passage
 * v4：PDF 逐页解析 + 页码（page_no）+ 两级层级（章/节）+ 空章节过滤
 * - PDF 有书签 → outline 两级树（章 + 一级子项为节），页码精准
 * - 无书签 → 文本标题识别（第X章=章、第X节=节），行级页码映射
 */
const debug = require('debug')
const crypto = require('crypto')
const { db } = require('../db')
const { segment } = require('./tokenizer')

const log = debug('qa:ingest')

// 支持的文件类型
const SUPPORTED_EXTS = ['txt', 'md', 'pdf']

/**
 * 解析文件为纯文本（PDF 附带逐页文本 + 两级书签 outline）
 * @returns {Promise<{text: string, pages: Array|null, filteredPages: Array|null, pdfOutline: Array|null}>}
 */
const parseFile = async (buffer, filename) => {
    const ext = (filename.split('.').pop() || '').toLowerCase()
    if (!SUPPORTED_EXTS.includes(ext)) {
        throw new Error(`不支持的文件格式 .${ext}，请上传 TXT / MD / PDF`)
    }
    if (ext === 'txt' || ext === 'md') {
        return { text: buffer.toString('utf8').trim(), pages: null, filteredPages: null, pdfOutline: null }
    }
    // PDF：pdfjs-dist 逐页提取，保留页码 + 两级书签目录（顶层=章，一级子项=节）
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const tc = await page.getTextContent()
        pages.push({ pageNo: i, text: reconstructPageText(tc) })
    }
    const pdfOutline = []
    try {
        const outline = await doc.getOutline()
        if (outline && outline.length > 0) {
            const pageIndexOf = async (dest) => {
                if (dest === undefined || dest === null) return null
                try {
                    // dest 是 [ref, {name}, x, y] 数组，getPageIndex 需要 ref 对象（页对象引用）
                    const ref = Array.isArray(dest) ? dest[0] : dest
                    return await doc.getPageIndex(ref)
                } catch { return null }
            }
            for (const it of outline) {
                if (!it.title) continue
                const top = { title: it.title, pageIdx: await pageIndexOf(it.dest), items: [] }
                if (it.items && it.items.length > 0) {
                    for (const sub of it.items) {
                        if (!sub.title) continue
                        top.items.push({ title: sub.title, pageIdx: await pageIndexOf(sub.dest) })
                    }
                }
                if (top.pageIdx !== null) pdfOutline.push(top)
            }
        }
    } catch { /* outline 解析失败不影响主流程 */ }
    await doc.destroy().catch(() => {})

    // 目录页过滤（无书签时的文本切分用）："标题 + 页码数字"密集的页视为目录页，从正文剔除
    const isTocPage = (pageText) => {
        const lines = pageText.split('\n').map(s => s.trim()).filter(s => s.length > 0)
        if (lines.length < 8) return false
        const tocLike = lines.filter(l => /^[^。；]{2,30}\s*\d{1,3}\s*$/.test(l)).length
        return tocLike / lines.length > 0.5
    }
    const contentPages = pages.filter(p => !isTocPage(p.text))
    const safePages = contentPages.length > 0 ? contentPages : pages // 全被误判时保留全部
    // 页间插入空行：保证段落不跨页（段落页码 = 所在页）；与 buildLinePageMap 对齐
    const text = safePages.map(p => p.text).join('\n\n').trim()
    if (!text) {
        throw new Error('PDF 未提取到文本（可能是扫描件，无文字层，请上传文字版 PDF 或 TXT）')
    }
    // pages 保留原始逐页（outline 的 pageIdx 基于原始页）；filteredPages 为剔除目录页后的（文本模式行映射用）
    return { text, pages, filteredPages: safePages, pdfOutline: pdfOutline.length >= 3 ? pdfOutline : null }
}

/**
 * 重建 PDF 页文本：按 y 坐标分组恢复真实行结构（hasEOL 不可靠，会整页粘连）
 */
const reconstructPageText = (tc) => {
    const items = (tc.items || []).filter(it => it.str && it.str.trim())
    if (items.length === 0) return ''
    const rows = []
    let curY = null
    let curLine = ''
    const CJK = /[\u4e00-\u9fff]$/
    for (const it of items) {
        const y = it.transform ? it.transform[5] : 0
        const s = it.str || ''
        if (curY !== null && Math.abs(y - curY) > 3) {
            rows.push({ y: curY, text: curLine })
            curLine = s
        } else {
            if (curLine && !CJK.test(curLine.slice(-1)) && !/^[\u4e00-\u9fff]/.test(s)) curLine += ' '
            curLine += s
        }
        curY = y
    }
    if (curLine.trim()) rows.push({ y: curY, text: curLine })
    return rows.map(r => r.text).join('\n')
}

/** 构建 行号 → 页码 映射（PDF 逐页文本合并后使用；页间空行映射到当前页） */
const buildLinePageMap = (pages) => {
    if (!pages || pages.length === 0) return null
    const map = []
    for (let i = 0; i < pages.length; i++) {
        const lineCount = pages[i].text.split('\n').length
        for (let j = 0; j < lineCount; j++) map.push(pages[i].pageNo)
        if (i < pages.length - 1) map.push(pages[i].pageNo) // 页间空行（join('\n\n') 产生）
    }
    return map
}

/**
 * 用 PDF 书签 outline 切分两级章节树（章 = 顶层项，节 = 一级子项）
 * 内容边界：平铺顺序（章起点、节起点、下一节点起点）逐段填充；页间插空行（段落页码 = 所在页）
 * @returns {Array<{title: string, level: number, parentIndex: number, content: string, pageNo: number|null, lineMap: number[]|null}>}
 */
const splitByOutline = (outline, pages) => {
    // 平铺：章 → 其节 → 下章 → ...（level 1/2）
    const flat = []
    for (const top of outline) {
        if (/^(目录|目\s*录|contents?|前页|扉页)$/i.test(top.title.trim())) continue
        const ch = { title: top.title, level: 1, parentIndex: -1, pageIdx: top.pageIdx }
        flat.push(ch)
        const validSubs = (top.items || []).filter(s => s.pageIdx !== null && s.pageIdx > ch.pageIdx)
        for (const sub of validSubs) {
            flat.push({ title: sub.title, level: 2, parentIndex: flat.indexOf(ch), pageIdx: sub.pageIdx })
        }
    }
    // 内容填充：[startIdx, endIdx) 页文本
    const chapters = []
    for (let i = 0; i < flat.length; i++) {
        const cur = flat[i]
        const startIdx = cur.pageIdx
        const endIdx = i + 1 < flat.length ? flat[i + 1].pageIdx : pages.length
        if (startIdx >= pages.length || endIdx <= startIdx) continue
        const contentParts = []
        const lineMap = []
        for (let p = startIdx; p < endIdx; p++) {
            const lines = (pages[p].text || '').split('\n')
            if (p > startIdx) contentParts.push('')
            contentParts.push(lines.join('\n'))
            if (p > startIdx) lineMap.push(pages[p].pageNo) // 页间空行
            for (const _ of lines) lineMap.push(pages[p].pageNo)
        }
        let content = contentParts.join('\n').trim()
        if (content.length < 50) continue // 过滤封面/版权等空项
        // 节标题行从内容中保留（不剥离，展示时可读）
        chapters.push({ title: cur.title, level: cur.level, parentIndex: cur.parentIndex, content, pageNo: pages[startIdx].pageNo, lineMap })
    }
    // 重算 parentIndex（基于过滤后的最终数组索引）：节挂到前面最近的章
    let lastCh = -1
    for (let i = 0; i < chapters.length; i++) {
        if (chapters[i].level === 1) lastCh = i
        chapters[i].parentIndex = chapters[i].level === 1 ? -1 : lastCh
    }
    return chapters
}

/**
 * 按标题行切分两级章节树（文本模式：无 PDF 书签时使用）
 * 识别层级：第X章/篇/部分/# → 章；第X节/##/x.y → 节；数字编号"1."→章、"1.1"→节
 * 空章节过滤：内容 <50 字符的标题视为伪标题（如规则编号行），并入前一章节
 * @param {string} text
 * @param {number[]|null} linePageMap - 行号→页码映射（PDF），TXT/MD 传 null
 * @returns {Array<{title: string, level: number, parentIndex: number, content: string, pageNo: number|null, lineMap: number[]|null}>}
 */
const splitChapters = (text, linePageMap = null) => {
    const lines = text.split(/\r?\n/)
    const chapters = []
    const stack = [] // 章节栈：[{title, level, content, startLine, pageNo}]
    let lineNo = 0

    const headingLevel = (line) => {
        const t = line.trim()
        if (!t || t.length > 60) return null
        if (/^#{1,3}\s+\S/.test(t)) {
            const m = t.match(/^(#{1,3})\s+(.+)$/)
            return { title: m[2].trim(), level: m[1].length === 1 ? 1 : 2 } // #=章 ##/###=节
        }
        if (/^第[一二三四五六七八九十百千万0-9０-９]+章\s*\S?/.test(t)) return { title: t.trim(), level: 1 }
        if (/^第[一二三四五六七八九十百千万0-9０-９]+[节篇部分]\s*\S?/.test(t)) return { title: t.trim(), level: 2 }
        if (/^[一二三四五六七八九十]+、\S+/.test(t) && t.length <= 30) return { title: t.trim(), level: 1 }
        if (/^[0-9０-９]{1,3}[.．、]\s*\S+/.test(t) && t.length <= 30) {
            // "1." → 章；"1.1" → 节
            const m = t.match(/^([0-9０-９]{1,3})[.．、]([0-9０-９]{1,3})?/)
            return { title: t.trim(), level: m && m[2] !== undefined ? 2 : 1 }
        }
        return null
    }

    for (const line of lines) {
        const h = headingLevel(line)
        if (h) {
            // 数字编号标题（"1."）跟在章（"一、"/"第X章"）之后时，按上下文降级为节
            if (h.level === 1 && /^[0-9０-９]{1,3}[.．、]/.test(h.title) && stack.length > 0 && stack[stack.length - 1].level === 1) {
                h.level = 2
            }
            const node = { title: h.title, level: h.level, content: '', startLine: lineNo, pageNo: linePageMap ? linePageMap[lineNo] : null }
            // 栈式：弹出 level >= 当前的所有章节
            while (stack.length > 0 && stack[stack.length - 1].level >= h.level) stack.pop()
            stack.push(node)
            chapters.push(node)
        } else if (stack.length > 0) {
            stack[stack.length - 1].content += line + '\n'
        }
        lineNo++
    }

    if (chapters.length === 0) {
        return [{ title: '正文', level: 1, parentIndex: -1, content: text, pageNo: linePageMap ? linePageMap[0] : null, lineMap: null, startLine: 0 }]
    }

    // 伪标题过滤：内容 <50 字符的节点并入前一节点（消除"规则编号行"等伪章节）
    const cleaned = []
    for (const ch of chapters) {
        ch.content = ch.content.trim()
        if (ch.content.length < 50 && cleaned.length > 0) {
            // 合并进前一个（保持其层级归属）
            const prev = cleaned[cleaned.length - 1]
            prev.content += (prev.content ? '\n' : '') + ch.title + (ch.content ? '\n' + ch.content : '')
            continue
        }
        cleaned.push(ch)
    }

    // 计算 parentIndex（章=-1，节=最近章）
    const result = []
    let lastChapterIdx = -1
    for (const ch of cleaned) {
        if (ch.level === 1) {
            lastChapterIdx = result.length
            result.push({ title: ch.title, level: 1, parentIndex: -1, content: ch.content, pageNo: ch.pageNo, lineMap: null, startLine: ch.startLine })
        } else {
            const pi = lastChapterIdx >= 0 ? lastChapterIdx : -1
            result.push({ title: ch.title, level: 2, parentIndex: pi, content: ch.content, pageNo: ch.pageNo, lineMap: null, startLine: ch.startLine })
        }
    }
    return result
}

/**
 * 章节内容切分为段落（记录段落起始页码）
 * 按空行分块（PDF 页间有空行，段落页码 = 所在页），单块 >800 字时按句号/分号进一步切分
 * @param {string} content - 章节内容
 * @param {number} startLine - 内容起始行号
 * @param {number[]|null} linePageMap - 行号→页码映射（outline 模式传章节内映射，文本模式传全局映射）
 * @returns {Array<{content: string, pageNo: number|null}>}
 */
const splitPassages = (content, startLine = 0, linePageMap = null) => {
    const lines = content.split('\n')
    const blocks = []
    let buf = ''
    let bufLine = startLine
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        if (l.trim() === '') {
            if (buf.trim()) { blocks.push({ text: buf.trim(), line: bufLine }); buf = '' }
        } else {
            if (!buf) bufLine = startLine + i
            buf += l + ' '
        }
    }
    if (buf.trim()) blocks.push({ text: buf.trim(), line: bufLine })

    const passages = []
    for (const block of blocks) {
        if (block.text.length < 20) continue
        const pageNo = linePageMap ? linePageMap[block.line] : null
        if (block.text.length <= 800) {
            passages.push({ content: block.text, pageNo })
            continue
        }
        const parts = block.text.split(/(?<=[。；;！？!?])\s*/).filter(p => p.trim().length > 0)
        let bbuf = ''
        for (const part of parts) {
            if (bbuf.length + part.length > 500 && bbuf.length >= 50) {
                passages.push({ content: bbuf, pageNo })
                bbuf = part
            } else {
                bbuf += part
            }
        }
        if (bbuf.trim().length >= 20) passages.push({ content: bbuf, pageNo })
    }
    return passages
}

/**
 * 从文本前部提取候选书名（文件名无意义时使用）
 * 策略：跳过目录行（编号开头/第X章），取前 5000 字符中的首个更像书名的短行
 */
const extractTitleFromText = (text) => {
    const head = text.slice(0, 5000)
    const lines = head.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0)
    for (const line of lines.slice(0, 12)) {
        if (line.length < 2 || line.length > 60) continue
        if (/^[\d\s.\-—|]+$/.test(line)) continue
        // 跳过目录/编号行（一、二、1.、第X章、第X节）——这些是正文结构不是书名
        if (/^[一二三四五六七八九十]+、/.test(line)) continue
        if (/^第[一二三四五六七八九十百千万0-9０-９]+[章节篇部分]/.test(line)) continue
        if (/^[0-9０-９]{1,3}[.．、]/.test(line)) continue
        if (/^[（(][一二三四五六七八九十0-9]+[）)]/.test(line)) continue
        // 排除页眉页脚特征（出版社/网址/日期）
        if (/^(人民卫生出版社|卫生部|国家卫生健康|www\.|http|\d{4}年|ISBN)/i.test(line)) continue
        return line.slice(0, 60)
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
    const parsed = await parseFile(buffer, filename)
    return ingestFromText(parsed, filename, meta)
}

/**
 * 用已解析内容入库（preview 已解析过时直接复用，避免重复解析 PDF）
 * @param {{text: string, pages: Array|null, pdfOutline: Array|null}} parsed - parseFile 的返回值
 * @param {string} filename - 文件名（用作书名）
 * @param {Object} [meta] - { domain }
 * @returns {Promise<{bookId, bookTitle, chapterCount, passageCount}>}
 */
const ingestFromText = async (parsed, filename, meta = {}) => {
    const text = typeof parsed === 'string' ? parsed : parsed.text
    const pages = typeof parsed === 'object' ? parsed.pages : null
    const filteredPages = typeof parsed === 'object' ? parsed.filteredPages : null
    const pdfOutline = typeof parsed === 'object' ? parsed.pdfOutline : null

    // 书名：meta.title 优先（前端可编辑），否则文件名去扩展名；文件名无意义（纯数字/太短/无中文的长 hash 名）时从内容提取
    let bookTitle = ''
    if (meta.title && meta.title.trim()) {
        bookTitle = meta.title.trim()
    } else {
        bookTitle = (filename.replace(/\.[^.]+$/, '') || '未命名书籍').trim()
        if (!bookTitle || /^[\d\s]+$/.test(bookTitle) || bookTitle.length < 2 || /^[a-zA-Z0-9]{12,}$/.test(bookTitle)) {
            bookTitle = extractTitleFromText(text) || '未命名书籍'
        }
    }
    // 章节树：PDF 有书签 → outline 两级树；否则文本标题识别（两级）+ 行页码映射
    let chapters
    let globalLineMap = null
    if (pages && pdfOutline) {
        chapters = splitByOutline(pdfOutline, pages)
        if (chapters.length === 0) chapters = splitChapters(text, buildLinePageMap(filteredPages || pages))
    } else {
        globalLineMap = buildLinePageMap(filteredPages || pages)
        chapters = splitChapters(text, globalLineMap)
    }
    if (chapters.length === 0) throw new Error('未解析到有效内容')
    // 文本模式的节点补充全局行页码映射（段落页码 = 节点起始行 + 行内偏移）
    const outlineMode = !!(pages && pdfOutline && chapters.some(c => c.lineMap))
    for (const ch of chapters) {
        if (!outlineMode && !ch.lineMap && globalLineMap) ch.lineMap = { global: true, startLine: ch.startLine || 0 }
    }

    const trx = await db.transaction()
    try {
        // 同名书籍已存在：递归禁用旧书整棵树（书→章→节）及其全部段落，避免子章节残留
        const oldBook = await trx('rag_source_doc')
            .where('title', bookTitle).andWhere('level', 0).andWhere('enabled', true).first()
        if (oldBook) {
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
            await trx('rag_passage').whereIn('doc_id', allIds).update({ enabled: false })
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

        // 2. 批量建章/节（level 1/2，带页码；章挂书下、节挂章下）
        const nodeRows = []
        const nodeMeta = [] // [{idIndex, level}] 记录节点在 chapters 中的索引与层级，用于段落挂载
        for (let i = 0; i < chapters.length; i++) {
            const ch = chapters[i]
            const parentId = ch.level === 1 ? bookId : null // 节的 parent 在章插入后回填
            nodeRows.push({
                title: ch.title,
                doc_type: 'chapter',
                domain: meta.domain || '医学',
                keywords: [],
                file_path: filename,
                parent_id: parentId,
                level: ch.level,
                page_no: ch.pageNo || null,
                node_path: `/${bookTitle}/${ch.title}`,
                enabled: true,
                created_at: new Date(),
            })
            nodeMeta.push({ chIndex: i, level: ch.level, parentIndex: ch.parentIndex })
        }
        const nodeIds = await trx('rag_source_doc').insert(nodeRows).returning('id')
        // 回填节节点的 parent_id（章 id）
        const chapterIdByIndex = {}
        for (let i = 0; i < nodeMeta.length; i++) {
            if (nodeMeta[i].level === 1) chapterIdByIndex[i] = nodeIds[i]
        }
        const secUpdates = []
        for (let i = 0; i < nodeMeta.length; i++) {
            if (nodeMeta[i].level === 2 && nodeMeta[i].parentIndex >= 0 && chapterIdByIndex[nodeMeta[i].parentIndex] !== undefined) {
                secUpdates.push(trx('rag_source_doc').where('id', nodeIds[i]).update({ parent_id: chapterIdByIndex[nodeMeta[i].parentIndex] }))
            }
        }
        if (secUpdates.length > 0) await Promise.all(secUpdates)

        // 3. 批量写段落（挂叶节点：节存在挂节，否则挂章；带页码）
        let passageCount = 0
        const passageRows = []
        const docIdFor = (i) => {
            // 段落挂载目标：若该节点有"其后紧邻的子节"，段落归属应在其子节；简化：段落挂节点自身（outline 模式节内容独立）
            return nodeIds[i]
        }
        for (let i = 0; i < chapters.length; i++) {
            const ch = chapters[i]
            let passages
            if (Array.isArray(ch.lineMap)) {
                passages = splitPassages(ch.content, 0, ch.lineMap) // outline 模式：章节内行号映射
            } else if (ch.lineMap && ch.lineMap.global && globalLineMap) {
                passages = splitPassages(ch.content, ch.lineMap.startLine + 1, globalLineMap) // 文本模式：全局行映射
            } else {
                passages = splitPassages(ch.content, 0, null)
            }
            for (const p of passages) {
                passageRows.push({
                    doc_id: docIdFor(i),
                    section_path: ch.title,
                    page_no: p.pageNo || null,
                    content: p.content,
                    content_terms: segment(p.content),
                    embedding: null,
                    content_hash: crypto.createHash('md5').update(p.content).digest('hex'),
                    enabled: true,
                    created_at: new Date(),
                })
                passageCount++
            }
        }
        if (passageRows.length > 0) {
            await trx('rag_passage').insert(passageRows)
        }

        await trx.commit()
        log(`[ingest] 入库成功《${bookTitle}》: ${chapters.filter(c => c.level === 1).length}章 / ${chapters.filter(c => c.level === 2).length}节 / ${passageCount}段`)
        return { bookId, bookTitle, chapterCount: chapters.filter(c => c.level === 1).length, sectionCount: chapters.filter(c => c.level === 2).length, passageCount }
    } catch (error) {
        await trx.rollback()
        throw error
    }
}

module.exports = { parseFile, buildLinePageMap, splitChapters, splitPassages, splitByOutline, extractTitleFromText, ingestBook, ingestFromText, SUPPORTED_EXTS }
