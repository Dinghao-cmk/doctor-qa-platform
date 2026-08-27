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
        pages.push({ pageNo: i, ...reconstructPageText(tc) })
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

    // 目录页检测与条目提取（按目录划分章节——出版方权威结构）
    // 目录行格式："标题 + 点线 + 页码" / "标题+页码紧贴" / 标题行（页码在下一行点线行）
    const TOC_TITLE_RE = /^(.{2,40}?)(?:\s*[.．·]+\s*(\d{1,3})|(\d{1,3}))\s*$/ // 标题+点线+页码 或 标题+页码
    const DOT_PAGE_RE = /^[.．·\s]{5,}(\d{1,3})\s*$/ // 纯点线+页码
    const DOT_ONLY_RE = /^[.．·\s]{5,}$/ // 纯点线
    const extractTocEntries = (pageText) => {
        const lines = pageText.split('\n').map(s => s.trim()).filter(s => s.length > 0)
        const entries = []
        let pendingTitle = null
        for (const line of lines) {
            const m = line.match(TOC_TITLE_RE)
            if (m) {
                const title = (m[1] || '').replace(/[.．·\s]+$/g, '').trim()
                const pageNum = parseInt(m[2] || m[3], 10)
                // 排除索引页词条（中英对照词条含英文；纯数字行）
                if (title.length >= 2 && pageNum > 0 && !/[a-zA-Z]{2,}/.test(title) && !/^\d{1,3}$/.test(title)) {
                    entries.push({ title, pageNum })
                }
                pendingTitle = null
            } else if (DOT_PAGE_RE.test(line)) {
                const pageNum = parseInt(line.match(DOT_PAGE_RE)[1], 10)
                if (pendingTitle && pageNum > 0 && !/[a-zA-Z]{2,}/.test(pendingTitle) && !/^\d{1,3}$/.test(pendingTitle)) {
                    entries.push({ title: pendingTitle, pageNum })
                }
                pendingTitle = null
            } else if (DOT_ONLY_RE.test(line)) {
                // 纯点线行：跳过
            } else if (line.length >= 2 && line.length <= 40 && !/^\d{1,3}$/.test(line) && !/[。；]/.test(line)) {
                pendingTitle = line // 可能是无页码的条目标题（页码在下一行）
            } else {
                pendingTitle = null
            }
        }
        return entries
    }
    const isTocPage = (pageText) => {
        const lines = pageText.split('\n').map(s => s.trim()).filter(s => s.length > 0)
        if (lines.length < 5) return false
        // 目录行特征：标题+点线+页码 / 纯点线+页码 / 纯点线 / 短标题行（无页码，如"第一章绪论""第一节xxx"）
        const isTocLine = (l) => TOC_TITLE_RE.test(l) || DOT_PAGE_RE.test(l) || DOT_ONLY_RE.test(l)
            || (l.length >= 2 && l.length <= 40 && !/^\d{1,3}$/.test(l) && !/[。；]/.test(l))
        const tocLike = lines.filter(isTocLine).length
        if (tocLike / lines.length <= 0.35) return false
        // 防索引页误判：目录条目应大部分带编号前缀（第X章/第X节/一、/1.）
        const entries = extractTocEntries(pageText)
        if (entries.length < 3) return false
        const numbered = entries.filter(e => /^(第[一二三四五六七八九十百千万0-9０-９]+[章节篇]|附[录篇]|[一二三四五六七八九十]+、|[0-9０-９]{1,3}[.．、])/.test(e.title)).length
        return numbered / entries.length >= 0.5
    }
    const tocEntries = []
    const tocPages = []
    for (const p of pages) {
        if (isTocPage(p.text)) {
            tocEntries.push(...extractTocEntries(p.text))
            tocPages.push(p)
        }
    }
    // 目录条目层级推断（共用规则 inferTocLevels）
    inferTocLevels(tocEntries)
    // 目录页文本（供 LLM 提取+判断层级；正则提取 tocEntries 作为兜底）
    const tocText = tocEntries.length >= 3 ? tocPages.map(p => p.text).join('\n') : null
    const contentPages = pages.filter(p => !isTocPage(p.text))
    const safePages = contentPages.length > 0 ? contentPages : pages // 全被误判时保留全部
    // 页间插入空行：保证段落不跨页（段落页码 = 所在页）；同时构建与 text 完全对齐的行号→页码/字号映射
    const textParts = []
    const linePageAcc = []
    const lineSizeAcc = []
    for (let i = 0; i < safePages.length; i++) {
        const p = safePages[i]
        if (!p.text) continue // 空页（无文本）不产生行，join 时只贡献分隔符
        const lines = p.text.split('\n')
        textParts.push(p.text)
        for (let j = 0; j < lines.length; j++) {
            linePageAcc.push(p.pageNo)
            lineSizeAcc.push((p.sizes || [])[j] || null)
        }
        // 页间空行：仅在后面还有非空页时插入（与 join('\n') 行为一致）
        let nextIdx = i + 1
        while (nextIdx < safePages.length && !safePages[nextIdx].text) nextIdx++
        if (nextIdx < safePages.length) {
            textParts.push('')
            linePageAcc.push(p.pageNo)
            lineSizeAcc.push(null)
        }
    }
    const text = textParts.join('\n').trim()
    if (!text) {
        throw new Error('PDF 未提取到文本（可能是扫描件，无文字层，请上传文字版 PDF 或 TXT）')
    }
    // pages 保留原始逐页（outline 的 pageIdx 基于原始页）；filteredPages 为剔除目录页后的（文本模式行映射用）
    return {
        text, pages, filteredPages: safePages,
        pdfOutline: pdfOutline.length >= 3 ? pdfOutline : null,
        tocEntries: tocEntries.length >= 5 ? tocEntries : null, tocText,
        linePageMap: linePageAcc, lineSizeMap: lineSizeAcc,
    }
}

/**
 * 重建 PDF 页文本：按 y 坐标分组恢复真实行结构（hasEOL 不可靠，会整页粘连）
 * 新版（含 sizes）见下方 buildLineSizeMap 之上的定义
 */

/**
 * 重建页文本（y 坐标分组）：返回 { text, sizes }，sizes 为每行的字号信息 {min, max}
 * max=行内最大字号（标题定级：章标题≈2倍正文）；min=行内最小字号（页眉识别：页眉标题常混 8px 小字）
 */
const reconstructPageText = (tc) => {
    const items = (tc.items || []).filter(it => it.str && it.str.trim())
    if (items.length === 0) return { text: '', sizes: [] }
    const rows = []
    let curY = null
    let curLine = ''
    let curMin = 0
    let curMax = 0
    const CJK = /[\u4e00-\u9fff]$/
    for (const it of items) {
        const y = it.transform ? it.transform[5] : 0
        const size = it.transform ? it.transform[0] : 0 // x 缩放 ≈ 字号
        const s = it.str || ''
        if (curY !== null && Math.abs(y - curY) > 3) {
            rows.push({ text: curLine, min: curMin, max: curMax })
            curLine = s
            curMin = size
            curMax = size
        } else {
            if (curLine && !CJK.test(curLine.slice(-1)) && !/^[\u4e00-\u9fff]/.test(s)) curLine += ' '
            curLine += s
            curMin = curMin > 0 ? Math.min(curMin, size) : size
            curMax = Math.max(curMax, size)
        }
        curY = y
    }
    if (curLine.trim()) rows.push({ text: curLine, min: curMin, max: curMax })
    return { text: rows.map(r => r.text).join('\n'), sizes: rows.map(r => ({ min: r.min, max: r.max })) }
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

/** 构建 行号 → 字号信息 映射（与 buildLinePageMap 对齐；{min, max}；用于标题字号定级与页眉过滤） */
const buildLineSizeMap = (pages) => {
    if (!pages || pages.length === 0) return null
    const map = []
    for (let i = 0; i < pages.length; i++) {
        const sizes = pages[i].sizes || []
        const lineCount = pages[i].text.split('\n').length
        for (let j = 0; j < lineCount; j++) map.push(sizes[j] || null)
        if (i < pages.length - 1) map.push(null) // 页间空行
    }
    return map
}

/** 计算正文字号（全局最常见的非零 max 字号） */
const calcBaseSize = (sizeMap) => {
    if (!sizeMap) return 0
    const freq = new Map()
    for (const s of sizeMap) {
        const v = s && s.max ? s.max : 0
        if (v <= 0) continue
        const k = Math.round(v * 10) / 10
        freq.set(k, (freq.get(k) || 0) + 1)
    }
    let best = 0
    let bestCnt = 0
    for (const [k, c] of freq) {
        if (c > bestCnt) { bestCnt = c; best = k }
    }
    return best
}

/**
 * 用 PDF 书签 outline 切分两级章节树（章 = 顶层项，节 = 一级子项）
 * 内容边界：平铺顺序（章起点、节起点、下一节点起点）逐段填充；页间插空行（段落页码 = 所在页）
 * @returns {Array<{title: string, level: number, parentIndex: number, content: string, pageNo: number|null, lineMap: number[]|null}>}
 */
const splitByOutline = (outline, pages) => {
    // 平铺：章 → 其节 → 下章 → ...（level 1/2）；顶层数字条目（"2.xxx"）或附录内的"一、二、"条目按上下文降级为节
    const flat = []
    let lastTop = null // 最近的顶层章索引（用于数字/条目降级）
    let lastTopTitle = null
    for (const top of outline) {
        if (/^(目录|目\s*录|contents?|前页|扉页)$/i.test(top.title.trim())) continue
        const t = top.title.trim()
        const isNumItem = /^[0-9０-９]{1,3}[.．、]/.test(t)
        const isYiErItem = /^[一二三四五六七八九十]+、/.test(t)
        const parentIsAppendix = lastTopTitle !== null && /^附[录篇]/.test(lastTopTitle)
        const level = (isNumItem || (isYiErItem && parentIsAppendix)) && lastTop !== null ? 2 : 1
        const ch = { title: top.title, level, parentIndex: level === 2 ? lastTop : -1, pageIdx: top.pageIdx }
        flat.push(ch)
        if (level === 1) { lastTop = flat.length - 1; lastTopTitle = t }
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
 * 按目录（TOC）划分章节：目录条目在正文中匹配定位（去空白模糊匹配），构建两级树
 * 目录页码仅作参考，边界以正文匹配位置为准（自动获得真实页码）
 * @param {Array<{title: string, level: number}>} tocEntries - parseFile 提取的目录条目
 * @param {string} text - 过滤目录页后的正文文本
 * @param {number[]|null} linePageMap - 行号→页码映射
 * @returns {Array<{title, level, parentIndex, content, pageNo, lineMap, startLine}>}
 */
const splitByToc = (tocEntries, text, linePageMap = null) => {
    const lines = text.split('\n')
    // 归一化：去空白/点线/装饰符（目录"第一节 xxx" vs 正文"第一节|xxx"）
    const norm = s => s.replace(/[\s.．·…|｜\-—·]/g, '')
    // 正文匹配（保持目录顺序，从上次位置继续）
    let searchFrom = 0
    const matched = []
    for (const e of tocEntries) {
        const target = norm(e.title)
        if (target.length < 3) continue
        let found = -1
        for (let i = searchFrom; i < lines.length; i++) {
            const l = lines[i].trim()
            if (l.length >= 3 && norm(l) === target) { found = i; break }
        }
        if (found >= 0) { matched.push({ title: e.title, level: e.level, lineIdx: found }); searchFrom = found + 1 }
    }
    if (matched.length < 3) return []
    // 构建章节树
    const chapters = []
    let lastChapterIdx = -1
    for (let i = 0; i < matched.length; i++) {
        const cur = matched[i]
        const startLine = cur.lineIdx + 1 // 跳过标题行本身
        const endLine = i + 1 < matched.length ? matched[i + 1].lineIdx : lines.length
        if (endLine <= startLine) continue
        const content = lines.slice(startLine, endLine).join('\n').trim()
        if (content.length < 20) continue
        const pageNo = linePageMap ? linePageMap[startLine] : null
        if (cur.level === 1) lastChapterIdx = chapters.length
        const parentIndex = cur.level === 1 ? -1 : (lastChapterIdx >= 0 ? lastChapterIdx : -1)
        chapters.push({ title: cur.title, level: cur.level, parentIndex, content, pageNo, lineMap: null, startLine })
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
const splitChapters = (text, linePageMap = null, lineSizeMap = null) => {
    const lines = text.split(/\r?\n/)
    const chapters = []
    const stack = [] // 章节栈：[{title, level, content, startLine, pageNo}]
    let lineNo = 0
    // 正文字号（最常见的非零字号）——用于标题字号定级与页眉过滤
    const baseSize = calcBaseSize(lineSizeMap)

    const headingLevel = (line) => {
        const t = line.trim()
        if (!t || t.length > 60) return null
        if (/^#{1,3}\s+\S/.test(t)) {
            const m = t.match(/^(#{1,3})\s+(.+)$/)
            return { title: m[2].trim(), level: m[1].length === 1 ? 1 : 2 } // #=章 ##/###=节
        }
        if (/^第[一二三四五六七八九十百千万0-9０-９]+章\s*\S?/.test(t)) return { title: t.trim(), level: 1 }
        if (/^第[一二三四五六七八九十百千万0-9０-９]+[节篇部分]\s*\S?/.test(t)) return { title: t.trim(), level: 2 }
        if (/^附[录篇]\s*[0-9一二三四五六七八九十]*\s*\S?/.test(t) && t.length <= 30) return { title: t.trim(), level: 1 }
        if (/^[一二三四五六七八九十]+、\S+/.test(t) && t.length <= 30) return { title: t.trim(), level: 1 }
        if (/^[0-9０-９]{1,3}[.．、]\s*\S+/.test(t) && t.length <= 30) {
            // "1." → 章；"1.1" → 节
            const m = t.match(/^([0-9０-９]{1,3})[.．、]([0-9０-９]{1,3})?/)
            return { title: t.trim(), level: m && m[2] !== undefined ? 2 : 1 }
        }
        return null
    }

    // 页眉识别：统计标题候选行的全局出现次数（同一标题 ≥3 次 = 页眉/重复行）
    const titleFreq = new Map()
    for (const line of lines) {
        const t = line.trim()
        if (t && t.length <= 60 && headingLevel(t)) {
            titleFreq.set(t, (titleFreq.get(t) || 0) + 1)
        }
    }
    for (const line of lines) {
        const h = headingLevel(line)
        if (h) {
            // 字号信息（行内 min/max）
            const sizeInfo = lineSizeMap ? lineSizeMap[lineNo] : null
            const size = sizeInfo ? sizeInfo.max : null
            // 页眉过滤：同一标题重复 ≥3 次（每页页眉）且非大字号标题（真章标题如 21px 有豁免）
            if (titleFreq.get(line.trim()) >= 3 && !(size && size > 0 && baseSize > 0 && size >= baseSize * 1.45)) {
                if (stack.length > 0) stack[stack.length - 1].content += line + '\n'
                lineNo++
                continue
            }
            // 字号定级（排版硬信号）：标题行字号显著大于正文字号 → 章/节；小于正文 → 页眉等非标题（跳过）
            // 无字号信息（txt/扫描）时保持规则判定
            if (size && size > 0 && baseSize > 0) {
                if (size < baseSize * 0.85) {
                    // 页眉/小字（如每页重复的"第一章 绪论"页眉）：不作为标题，并入内容
                    if (stack.length > 0) stack[stack.length - 1].content += line + '\n'
                    lineNo++
                    continue
                }
                if (size >= baseSize * 1.45) h.level = 1
                else if (size >= baseSize * 1.18) h.level = 2
                else if (/^[一二三四五六七八九十]+、/.test(h.title) || /^[0-9０-９]{1,3}[.．、]/.test(h.title)) h.level = 2
                // 正文大小（≤1.18x）且带编号：同级编号两级重复的书（如指南"一、"既是章又是节）靠字号区分——小字号条目为节
                // 其余保持规则判定
            }
            // 上下文降级为节：①数字编号（"1."）跟在章后；②"一、二、"跟在"附录X"后（附录内的地区/条目是二级）
            // 判断基于最近的 L1 祖先（降级后的节也在栈中，不能只看栈顶）
            if (h.level === 1 && stack.length > 0) {
                const topL1 = [...stack].reverse().find(s => s.level === 1)
                const isNumItem = /^[0-9０-９]{1,3}[.．、]/.test(h.title)
                const isYiErItem = /^[一二三四五六七八九十]+、/.test(h.title)
                const parentIsAppendix = topL1 && /^附[录篇]/.test(topL1.title)
                if (isNumItem || (isYiErItem && parentIsAppendix)) h.level = 2
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

    // 伪标题过滤：内容极短（<20字）或表格注释特征（数字+星号、食谱注释）的节点并入前一节点
    // 阈值 20：避免误杀内容较少的真节（旧阈值 50 会把 30-50 字的真节吞掉）
    const isFakeTitle = (ch) => {
        if (ch.content.length < 20) return true
        const t = ch.title.trim()
        if (/^[0-9０-９]{1,3}\s*[.．、]\s*\*/.test(t)) return true
        if (/为食谱中用到的食药物质/.test(t)) return true
        return false
    }
    const cleaned = []
    for (const ch of chapters) {
        ch.content = ch.content.trim()
        if (isFakeTitle(ch) && cleaned.length > 0) {
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
 * 目录条目层级推断（正则规则）：第X章=1 / 第X节=2 / 附录=1 / 数字条目=2 / "一、二、"=1（跟节/附录后=2）
 * 从 parseFile 提取的共用逻辑（LLM 提取的标题也走此规则）
 */
const inferTocLevels = (entries) => {
    let prevLevel = 1
    let prevTitle = ''
    for (const e of entries) {
        const t = (e.title || '').trim()
        let lv
        if (/^第[一二三四五六七八九十百千万0-9０-９]+章/.test(t)) lv = 1
        else if (/^第[一二三四五六七八九十百千万0-9０-９]+[节篇部分]/.test(t)) lv = 2
        else if (/^附[录篇]/.test(t)) lv = 1
        else if (/^[0-9０-９]{1,3}[.．、]/.test(t)) lv = 2
        else if (/^[一二三四五六七八九十]+、/.test(t)) {
            if (prevTitle && /^第[一二三四五六七八九十百千万0-9０-９]+[节篇部分]/.test(prevTitle)) lv = 2
            else if (prevTitle && /^附[录篇]/.test(prevTitle)) lv = 2
            else if (prevTitle && /^[0-9０-９]{1,3}[.．、]/.test(prevTitle)) lv = 2
            else if (prevTitle && /^[一二三四五六七八九十]+、/.test(prevTitle)) lv = prevLevel
            else lv = 1
        } else lv = 1
        e.level = lv
        prevLevel = lv
        prevTitle = t
    }
    return entries
}

/**
 * 用本地模型（Ollama）从目录页原文提取章节标题列表
 * 模型直接读目录文本，可识别正则提取不出的标题（如"附录2"粘连行）；层级由正则规则 inferTocLevels 判断（已验证更稳）
 * @param {string} tocText - 目录页文本（含页码）
 * @returns {Promise<Array<{title: string}>|null>} - 失败返回 null（调用方用正则提取兜底）
 */
const extractTocWithLLM = async (tocText) => {
    try {
        const model = process.env.LLM_STRUCT_MODEL || 'qwen2.5-7b-med-qa:latest'
        const prompt = '你是PDF文档解析助手。下面是PDF目录页的文本（每行是"标题 + 页码"或"标题 + 点线 + 页码"格式，夹有页眉数字）。\n' +
            '任务：提取目录中所有章节条目的标题。\n' +
            '要求：\n' +
            '- 标题原样输出（去掉尾部点线和页码，不要翻译、不要改写、不要增删字）\n' +
            '- 跳过页眉页码、"目录"页标题、纯点线行\n' +
            '- 按出现顺序输出\n' +
            '输出 JSON 数组，每个元素 {"t": 标题}。\n' +
            '只输出 JSON，不要任何其他内容。'
        const r = await fetch('http://localhost:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt + '\n目录文本:\n' + tocText.slice(0, 9000) }],
                format: 'json',
                stream: false,
                // num_ctx 8192：目录文本 + 输出 JSON 需更大上下文（模型默认 4096 会 400）
                options: { temperature: 0, num_ctx: 8192 },
            }),
            signal: AbortSignal.timeout(180000),
        })
        if (!r.ok) return null
        const data = await r.json()
        const content = (data.message && data.message.content) || ''
        const parsed = JSON.parse(content)
        const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null)
        if (!arr || arr.length < 3 || arr.length > 500) return null
        const out = []
        for (const it of arr) {
            const t = String(it.t || it.title || '').replace(/[.．·\s]+$/g, '').trim()
            if (t.length < 2 || t.length > 60) continue
            out.push({ title: t })
        }
        if (out.length < 3) return null
        return out
    } catch (e) {
        log('LLM 目录提取失败: ' + (e.message || e))
        return null
    }
}

/**
 * 构建两级章节树（preview 与入库共用）：目录页(LLM提取→正则提取) > PDF书签 > 文本标题识别
 * @param {{text: string, pages: Array|null, filteredPages: Array|null, pdfOutline: Array|null, tocEntries: Array|null, tocText: string|null}|string} parsed - parseFile 返回值或纯文本
 * @returns {Promise<Array<{title, level, parentIndex, content, pageNo, lineMap, startLine}>>}
 */
const buildChapters = async (parsed) => {
    const text = typeof parsed === 'string' ? parsed : parsed.text
    const pages = typeof parsed === 'object' ? parsed.pages : null
    const filteredPages = typeof parsed === 'object' ? parsed.filteredPages : null
    const pdfOutline = typeof parsed === 'object' ? parsed.pdfOutline : null
    const globalLineMap = parsed.linePageMap || buildLinePageMap(filteredPages || pages)
    const globalSizeMap = parsed.lineSizeMap || buildLineSizeMap(filteredPages || pages)
    let chapters = null
    // 1) 目录页：正则提取标题+层级为主（标题原样来自目录行，最可靠）；LLM 仅在正则提取不足时兜底
    if (typeof parsed === 'object' && (parsed.tocText || parsed.tocEntries)) {
        let entries = parsed.tocEntries
        if ((!entries || entries.length < 5) && parsed.tocText) {
            const llmTitles = await extractTocWithLLM(parsed.tocText)
            if (llmTitles && llmTitles.length >= 3) {
                entries = inferTocLevels(llmTitles)
            }
        }
        if (entries && entries.length >= 3) chapters = splitByToc(entries, text, globalLineMap)
    }
    // 2) PDF 书签
    if (!chapters || chapters.length === 0) {
        if (pages && pdfOutline) {
            chapters = splitByOutline(pdfOutline, pages)
            if (chapters.length === 0) chapters = splitChapters(text, globalLineMap, globalSizeMap)
        } else {
            chapters = splitChapters(text, globalLineMap, globalSizeMap)
        }
    }
    if (chapters.length === 0) throw new Error('未解析到有效内容')
    // 文本/toc 模式的节点补充全局行页码映射（段落页码 = 节点起始行 + 行内偏移）
    const outlineMode = !!(pages && pdfOutline && chapters.some(c => Array.isArray(c.lineMap)))
    for (const ch of chapters) {
        if (!outlineMode && !ch.lineMap && globalLineMap) ch.lineMap = { global: true, startLine: ch.startLine || 0 }
    }
    return chapters
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
    // 章节树：目录页(LLM层级) > PDF书签 > 文本标题识别（preview 与入库共用 buildChapters）
    const chapters = await buildChapters(parsed)

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

module.exports = { parseFile, buildLinePageMap, buildLineSizeMap, splitChapters, splitPassages, splitByOutline, splitByToc, buildChapters, extractTocWithLLM, extractTitleFromText, ingestBook, ingestFromText, SUPPORTED_EXTS }
