// ------------------------------------------------------------------------------
// 文件名称: ragPageIndex.js
// 主要功能: RAG 分层目录索引（PageIndex）— Stage 1 目录路由 + 定向检索
// 设计要点:
//   - getPageRoute: 直连 RAG 库（ragKnex）查 rag_rule_doc_map（零 HTTP、零向量，纯 SQL）
//   - pageIndexSearch: 调用远程 RAG 服务做定向向量检索（doc/passage 范围内精检）
//   - 内置本地 LRU 缓存（路由数据相对静态，避免重复 DB 查询）
//   - 任意异常或空结果时返回 null，调用方据此降级到扁平 ragVerifySearch
//   - 支持手动 invalidate 缓存（知识入库后刷新）
// ------------------------------------------------------------------------------

const debug = require('debug')
const agent = require('superagent')
const crypto = require('crypto')
const ragKnex = require('./ragKnexfile') // RAG 库专用 knex 实例
const { RAG_SERVER_ROOT } = require('../constant')
const askLLM = require('./askLLM')

const log = debug('qc:rag-pageindex')

// ── 远程接口地址（仅 pageIndexSearch 使用） ──────────────────────────
const RAG_PAGEINDEX_SEARCH_URL = RAG_SERVER_ROOT + '/rag_pageindex_search'

// ── 本地 LRU 缓存 ─────────────────────────────────────────────────
// 路由映射相对静态（知识入库时才变化），本地缓存可大幅减少 HTTP 调用
// Map 天然按插入顺序迭代，配合 maxSize 实现简易 LRU
const MAX_CACHE_SIZE = 500
const routeCache = new Map()

/**
 * 从缓存中获取路由信息（命中时刷新访问顺序）
 * @param {string} qcCode
 * @returns {Object|null|undefined} 缓存命中返回数据（含 null 表示"已确认无映射"），未命中返回 undefined
 */
const getCachedRoute = (qcCode) => {
    if (!routeCache.has(qcCode)) return undefined
    const val = routeCache.get(qcCode)
    // 刷新访问顺序（删后重插到末尾）
    routeCache.delete(qcCode)
    routeCache.set(qcCode, val)
    return val
}

/**
 * 写入缓存（超限时淘汰最早条目）
 */
const setCachedRoute = (qcCode, data) => {
    if (routeCache.size >= MAX_CACHE_SIZE) {
        // 淘汰最早插入的（Map 的 LRU 特性）
        const oldestKey = routeCache.keys().next().value
        routeCache.delete(oldestKey)
    }
    routeCache.set(qcCode, data)
}

// ── 核心函数 ──────────────────────────────────────────────────────

/**
 * getPageRoute: Stage 1 目录路由（直连 RAG 库，零 HTTP 开销）
 * 查询 rag_rule_doc_map 获取指定质控编码关联的文档/段落 ID 列表
 *
 * SQL 逻辑:
 *   SELECT doc_id, passage_ids FROM data.rag_rule_doc_map
 *   WHERE note_qc_code = ? AND enabled = true
 *   ORDER BY relevance DESC
 *
 * @param {string} noteQcCode - 质控编码（如 'A010.001'，对应 emr_eval_item.codev2）
 * @returns {Promise<{docIds: number[], passageIds: number[]}|null>}
 *   - 有映射：{ docIds: [1,3,5], passageIds: [12,15,20] }
 *   - 无映射或表不存在：null（调用方应降级到扁平搜索）
 */
const getPageRoute = async (noteQcCode) => {
    if (!noteQcCode) return null

    // 1. 查缓存
    const cached = getCachedRoute(noteQcCode)
    if (cached !== undefined) {
        log(`[cache hit] ${noteQcCode} →`, cached)
        return cached // 可能是 null（已确认无映射）或 { docIds, passageIds }
    }

    // 2. 直连 RAG 库查询 rag_rule_doc_map
    try {
        const rows = await ragKnex('rag_rule_doc_map')
            .select('doc_id', 'passage_ids')
            .where('note_qc_code', noteQcCode)
            .andWhere('enabled', true)
            .orderBy('relevance', 'desc')

        if (!rows || rows.length === 0) {
            // ── 层级继承：A004.001 找不到时尝试父编码 A004 ──
            if (noteQcCode.includes('.')) {
                const parentCode = noteQcCode.replace(/\.[^.]+$/, '')
                log(`[route inherit] ${noteQcCode} 无映射，尝试父编码 ${parentCode}`)
                const parentRoute = await getPageRoute(parentCode)
                if (parentRoute) {
                    setCachedRoute(noteQcCode, parentRoute) // 缓存继承结果
                    return parentRoute
                }
            }
            log(`[route miss] ${noteQcCode} — 无映射，缓存 null`)
            setCachedRoute(noteQcCode, null)
            return null
        }

        // 聚合：收集所有 doc_id 和 passage_ids（去重）
        const docIdSet = new Set()
        const passageIdSet = new Set()
        for (const row of rows) {
            docIdSet.add(row.doc_id)
            // passage_ids 是 PG 的 int[] 类型，knex 解析为 JS 数组
            if (Array.isArray(row.passage_ids)) {
                for (const pid of row.passage_ids) {
                    passageIdSet.add(pid)
                }
            }
        }

        const route = {
            docIds: [...docIdSet],
            passageIds: [...passageIdSet],
        }

        log(`[route hit] ${noteQcCode} → docs: ${route.docIds.length}, passages: ${route.passageIds.length}`)
        setCachedRoute(noteQcCode, route)
        return route
    } catch (error) {
        // 表不存在或字段缺失（建表 SQL 尚未执行）→ 优雅降级
        if (/relation.*does not exist|column.*does not exist/i.test(error.message)) {
            log(`[route skip] rag_rule_doc_map 表尚未创建，降级返回 null`)
            setCachedRoute(noteQcCode, null)
        } else if (/password authentication|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect|socket/i.test(error.message)) {
            // ── 连接类错误：数据库不可达/密码错误，必须大声报错 ──
            // 不能用 debug 日志（生产不开 DEBUG 会静默），否则知识库挂了质控会全部默认放行而无人知晓
            console.error(`[RAG路由严重告警] 数据库连接失败，质控知识检索已降级为默认放行！qc=${noteQcCode} 错误: ${error.message}`)
            log(`[route conn-error] ${noteQcCode} — ${error.message}，降级返回 null（不缓存，下次重试）`)
        } else {
            log(`[route error] ${noteQcCode} — ${error.message}，降级返回 null`)
        }
        return null
    }
}

/**
 * pageIndexSearch: 分层索引搜索
 * 在 Stage 1 路由缩小范围后，调用远程服务做定向检索
 *
 * @param {Object} options
 * @param {string} options.queryText - 缺陷描述/查询文本
 * @param {string} options.noteQcCode - 质控编码
 * @param {number[]} options.docIds - Stage 1 命中的文档 ID 列表
 * @param {number[]} [options.passageIds] - Stage 1 命中的段落 ID 列表（可选）
 * @param {number} [options.similarityThreshold=0.6] - 相似度阈值
 * @param {number} [options.limitCount=3] - 返回条数上限
 * @returns {Promise<any[]|null>} 检索结果数组，失败时返回 null
 */
const pageIndexSearch = async ({
    queryText,
    noteQcCode,
    docIds,
    passageIds,
    similarityThreshold = 0.6,
    limitCount = 3,
}) => {
    try {
        log(`[pageindex search] qc=${noteQcCode}, docs=${docIds?.length}, passages=${passageIds?.length}`)
        const response = await agent
            .post(RAG_PAGEINDEX_SEARCH_URL)
            .send({
                query_text: queryText,
                note_qc_code: noteQcCode,
                doc_ids: docIds,
                passage_ids: passageIds || [],
                similarity_threshold: similarityThreshold,
                limit_count: limitCount,
            })
            .set('Content-Type', 'application/json')
            .set('X-Request-ID', crypto.randomUUID().slice(0, 12))

        const results = response.body
        log(`[pageindex search] 返回 ${Array.isArray(results) ? results.length : 0} 条结果`)

        // ── 相似度阈值告警：top1 < 0.55 说明知识库可能缺少相关内容 ──
        if (Array.isArray(results) && results.length > 0) {
            const top1 = results[0]
            const top1Sim = top1.similarity ?? 0
            if (top1Sim < 0.55) {
                log(`[pageindex WARNING] top1 相似度仅 ${top1Sim.toFixed(3)}（<0.55），知识库可能缺少「${(queryText || '').slice(0, 30)}」相关内容，qc=${noteQcCode}`)
            }
        } else if (Array.isArray(results) && results.length === 0) {
            log(`[pageindex WARNING] 向量搜索零结果，qc=${noteQcCode}，query="${(queryText || '').slice(0, 30)}"`)
        }

        return results
    } catch (error) {
        log(`[pageindex search error] ${error.message}`)
        if (error.response) {
            log(`[pageindex search] 服务端状态码: ${error.response.status}`)
        }
        return null
    }
}

/**
 * invalidateRouteCache: 手动清除指定编码或全部路由缓存
 * 场景：知识入库后，映射关系可能变化，需刷新缓存
 *
 * @param {string} [noteQcCode] - 指定编码则仅清除该条；不传则清空全部
 */
const invalidateRouteCache = (noteQcCode) => {
    if (noteQcCode) {
        routeCache.delete(noteQcCode)
        log(`[cache invalidate] ${noteQcCode}`)
    } else {
        const size = routeCache.size
        routeCache.clear()
        log(`[cache invalidate all] cleared ${size} entries`)
    }
}

/**
 * getRouteCacheSize: 获取当前缓存条目数（监控/调试用）
 * @returns {number}
 */
const getRouteCacheSize = () => routeCache.size

// ── LLM 动态目录推理 ────────────────────────────────────────────────

// 目录树缓存（树结构相对静态，避免每次查库）
let docTreeCache = null
let docTreeCacheTime = 0
const DOC_TREE_CACHE_TTL = 5 * 60 * 1000 // 5 分钟

// 书籍列表缓存（Level 0，用于两级路由第一级）
let bookListCache = null
let bookListCacheTime = 0
const BOOK_LIST_CACHE_TTL = 10 * 60 * 1000 // 10 分钟

// ICD 编码缓存
let icdCache = null
let icdCacheTime = 0
const ICD_CACHE_TTL = 10 * 60 * 1000 // 10 分钟

/**
 * lookupIcdByQuery: ICD 编码导航 — 根据查询文本匹配 ICD 编码
 * 支持：
 *   1. 疾病名称匹配（"高血压" → I10-I15, body_system=循环系统）
 *   2. ICD 编码前缀匹配（"I10" → I10, I10.0, I11 等）
 *   3. 返回匹配的 body_system 列表，用于书籍粗筛加分
 *
 * @param {string} queryText - 查询文本
 * @returns {Promise<{bodySystems: string[], codes: Object[]}>}
 */
const lookupIcdByQuery = async (queryText) => {
    if (!queryText) return { bodySystems: [], codes: [] }

    // 加载 ICD 表（带缓存）
    if (!icdCache || Date.now() - icdCacheTime > ICD_CACHE_TTL) {
        try {
            icdCache = await ragKnex('rag_icd_code')
                .select('icd_code', 'icd_name', 'level', 'body_system', 'code_range', 'search_text')
                .where('enabled', true)
            icdCacheTime = Date.now()
        } catch (e) {
            log(`[icd] ICD表查询失败: ${e.message}`)
            return { bodySystems: [], codes: [] }
        }
    }

    if (!icdCache || icdCache.length === 0) return { bodySystems: [], codes: [] }

    const matchedCodes = []
    const systemSet = new Set()
    const queryLower = queryText.toLowerCase()

    for (const row of icdCache) {
        // 1. 编码前缀匹配（如查询包含 "I10"）
        if (row.icd_code.match(/^[A-Z]/) && queryLower.includes(row.icd_code.toLowerCase())) {
            matchedCodes.push(row)
            if (row.body_system) systemSet.add(row.body_system)
            continue
        }
        // 2. search_text 中的疾病名称匹配
        if (row.search_text) {
            const terms = row.search_text.split(/\s+/).filter(t => t.length >= 2)
            for (const term of terms) {
                if (queryLower.includes(term.toLowerCase())) {
                    matchedCodes.push(row)
                    if (row.body_system) systemSet.add(row.body_system)
                    break
                }
            }
        }
    }

    if (matchedCodes.length > 0) {
        log(`[icd] 匹配 ${matchedCodes.length} 条 ICD 编码, 系统: ${[...systemSet].join(', ')}`)
    }

    return {
        bodySystems: [...systemSet],
        codes: matchedCodes.slice(0, 20), // 限制返回数量
    }
}

/**
 * coarseFilterBooks: 两级路由第一级 — SQL 关键词粗筛
 * 从几百本书中快速筛选出最相关的 5-10 本，避免把整棵目录树塞给 LLM
 *
 * 匹配策略：
 *   1. 提取查询文本中的关键词（中文 4 字窗口 + 标点分割）
 *   2. 在 rag_source_doc（Level 0 书籍 + Level 1 章节）中匹配 title / domain / keywords
 *   3. 章节命中后反查到所属书籍
 *   4. 按命中数排序，取 top N
 *
 * @param {string} queryText - 查询文本
 * @param {number} [topN=10] - 最多返回几本书
 * @returns {Promise<number[]>} 命中的书籍 ID 列表
 */
const coarseFilterBooks = async (queryText, topN = 10) => {
    if (!queryText) return []

    // 获取书籍 + 章节 + 子章节列表（带缓存）
    if (!bookListCache || Date.now() - bookListCacheTime > BOOK_LIST_CACHE_TTL) {
        try {
            // 查 Level 0 书籍
            // 注意：不查询 authority_level（该列在部分环境的 rag_source_doc 表中不存在，
            // 查询会导致整个粗筛失败返回空数组，进而使 LLM 只能看全量目录树）
            // 缺少该列时权威性加权退化为默认 1（见下方 authorityMap）
            const books = await ragKnex('rag_source_doc')
                .select('id', 'title', 'domain', 'keywords', 'node_path')
                .where('level', 0)
                .andWhere('enabled', true)

            // 查 Level 1 章节
            const chapters = await ragKnex('rag_source_doc')
                .select('id', 'title', 'domain', 'parent_id', 'node_path')
                .where('level', 1)
                .andWhere('enabled', true)

            // 查 Level 2 子章节（具体疾病/操作名称）
            const subchapters = await ragKnex('rag_source_doc')
                .select('id', 'title', 'parent_id', 'node_path')
                .where('level', 2)
                .andWhere('enabled', true)

            bookListCache = { books, chapters, subchapters }
            bookListCacheTime = Date.now()
        } catch (error) {
            log(`[coarseFilter] 书籍列表查询失败: ${error.message}`)
            return []
        }
    }

    if (!bookListCache) return []
    const { books, chapters, subchapters } = bookListCache
    if (books.length === 0) return []

    // 提取查询关键词
    const stopWords2 = new Set(['患者', '需要', '选择', '处理', '管理', '诊断', '治疗', '入院', '急性', '并发', '合并'])
    const stopWords = new Set(['的', '了', '是', '在', '和', '与', '或', '及', '等', '应', '需', '为', '有', '不', '未', '对', '中', '上', '下', '该', '此', '怎么', '如何', '什么', '哪些', '多少'])
    const rawTokens = queryText
        .replace(/[，。、；：！？\s,.\;:\!\?\(\)\[\]（）【】]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2 && !stopWords.has(t))

    // 对长中文串提取重叠关键词（2-4字），2字词覆盖关键医学术语
    const keywords = []
    const isChinese = (ch) => /[\u4e00-\u9fa5]/.test(ch)
    for (const token of rawTokens) {
        if (token.length <= 4 || !isChinese(token[0])) {
            keywords.push(token)
        } else {
            // 提取 2/3/4 字窗口
            for (let i = 0; i <= token.length - 2; i++) {
                const w2 = token.slice(i, i + 2)
                if (!stopWords2.has(w2)) keywords.push(w2)
                if (i <= token.length - 3) keywords.push(token.slice(i, i + 3))
                if (i <= token.length - 4) keywords.push(token.slice(i, i + 4))
            }
        }
    }

    if (keywords.length === 0) return []

    // 构建层级映射：章节→书，子章节→章节→书
    const chapterToBook = {}
    for (const ch of chapters) {
        chapterToBook[ch.id] = ch.parent_id
    }
    const subchapterToBook = {}
    for (const sch of subchapters) {
        const chapterId = sch.parent_id
        if (chapterToBook[chapterId]) {
            subchapterToBook[sch.id] = chapterToBook[chapterId]
        }
    }

    // 对每本书计算匹配分数（书名 + 章节名联合匹配）
    const bookScoreMap = {}
    for (const book of books) {
        bookScoreMap[book.id] = 0
    }

    // 匹配书籍级别（title + domain + keywords）
    for (const book of books) {
        const searchText = `${book.title} ${book.domain || ''} ${(book.keywords || []).join(' ')}`.toLowerCase()
        for (const kw of keywords) {
            if (searchText.includes(kw.toLowerCase())) {
                bookScoreMap[book.id] += 2  // 书名命中权重高
            }
        }
    }

    // 匹配章节级别（title + domain），命中后反查到书
    for (const ch of chapters) {
        const searchText = `${ch.title} ${ch.domain || ''}`.toLowerCase()
        for (const kw of keywords) {
            if (searchText.includes(kw.toLowerCase())) {
                const bookId = chapterToBook[ch.id]
                if (bookId && bookScoreMap[bookId] !== undefined) {
                    bookScoreMap[bookId] += 1
                }
            }
        }
    }

    // 匹配子章节级别（具体疾病名），权重最高
    for (const sch of subchapters) {
        const searchText = sch.title.toLowerCase()
        for (const kw of keywords) {
            if (searchText.includes(kw.toLowerCase())) {
                const bookId = subchapterToBook[sch.id]
                if (bookId && bookScoreMap[bookId] !== undefined) {
                    bookScoreMap[bookId] += 3  // 子章节命中（具体疾病名）权重最高
                }
            }
        }
    }

    // ── ICD 编码导航加分 ──
    // 通过 ICD 编码表匹配疾病→系统→章节domain，给相关书籍加分
    try {
        const icdResult = await lookupIcdByQuery(queryText)
        if (icdResult.bodySystems.length > 0) {
            // ICD body_system → 章节 domain 关键词映射
            const systemToDomain = {
                '循环系统': ['心血管', '循环'],
                '呼吸系统': ['呼吸'],
                '消化系统': ['消化', '外科'],
                '内分泌': ['内分泌'],
                '感染': ['感染'],
                '肿瘤': ['肿瘤'],
            }
            const matchDomains = new Set()
            for (const sys of icdResult.bodySystems) {
                const domains = systemToDomain[sys] || []
                domains.forEach(d => matchDomains.add(d))
            }
            // 给章节 domain 匹配的书籍加分
            for (const ch of chapters) {
                if (ch.domain && matchDomains.has(ch.domain)) {
                    const bookId = chapterToBook[ch.id]
                    if (bookId && bookScoreMap[bookId] !== undefined) {
                        bookScoreMap[bookId] += 2  // ICD系统匹配加分
                    }
                }
            }
        }
    } catch (e) {
        log(`[coarseFilter] ICD加分异常: ${e.message}`)
    }

    // ── 权威性加权排序 ──
    // 最终得分 = 原始匹配分 × 权威性等级（指南4x > 教材2x > 其他1x）
    const authorityMap = {}
    for (const book of books) {
        authorityMap[book.id] = book.authority_level || 1
    }

    // 按加权分数降序，取 top N（过滤掉 0 分的）
    const matched = Object.entries(bookScoreMap)
        .filter(([, score]) => score > 0)
        .sort((a, b) => {
            const scoreA = a[1] * (authorityMap[parseInt(a[0])] || 1)
            const scoreB = b[1] * (authorityMap[parseInt(b[0])] || 1)
            return scoreB - scoreA
        })
        .slice(0, topN)
        .map(([id]) => parseInt(id))

    const matchedNames = matched.map(id => {
        const book = books.find(b => b.id === id)
        const raw = bookScoreMap[id]
        const auth = authorityMap[id] || 1
        return book ? `${book.title}(raw=${raw},auth=${auth},final=${raw * auth})` : id
    })
    log(`[coarseFilter] ${keywords.length}个关键词 → ${matched.length}本书命中: ${matchedNames.join(', ')}`)

    return matched
}

/**
 * getDocTree: 获取目录树摘要，供 LLM 推理使用
 * 支持两种模式：
 *   1. 无参数：返回全部目录树（兼容旧逻辑）
 *   2. bookIds 参数：只返回指定书籍的目录树（两级路由模式）
 *
 * 返回格式: [{ id, title, domain, node_path, children: [{ id, title, node_path, passage_count }] }]
 *
 * @param {number[]} [bookIds] - 限定书籍 ID 列表（null=全部）
 */
const getDocTree = async (bookIds = null) => {
    // 全量模式走缓存
    if (!bookIds && docTreeCache && Date.now() - docTreeCacheTime < DOC_TREE_CACHE_TTL) {
        return docTreeCache
    }

    try {
        // Level 1 章节查询
        const level1Query = ragKnex('rag_source_doc')
            .select('id', 'title', 'domain', 'node_path', 'parent_id')
            .where('level', 1)
            .andWhere('enabled', true)
            .orderBy('node_path')

        // 如果指定了 bookIds，只查这些书的章节
        if (bookIds && bookIds.length > 0) {
            level1Query.andWhere('parent_id', 'in', bookIds)
        }
        const chapters = await level1Query

        // Level 2 子章节
        const chapterIds = chapters.map(c => c.id)
        let subchapters = []
        if (chapterIds.length > 0) {
            subchapters = await ragKnex('rag_source_doc')
                .select('id', 'title', 'parent_id', 'node_path')
                .where('level', 2)
                .andWhere('enabled', true)
                .whereIn('parent_id', chapterIds)
                .orderBy('node_path')
        }

        // 统计段落数
        const passageCounts = await ragKnex('rag_passage')
            .select('doc_id')
            .count('* as cnt')
            .where('enabled', true)
            .groupBy('doc_id')

        const countMap = {}
        for (const row of passageCounts) {
            countMap[row.doc_id] = parseInt(row.cnt, 10)
        }

        // 组装树
        const tree = chapters.map((ch) => ({
            id: ch.id,
            title: ch.title,
            domain: ch.domain,
            node_path: ch.node_path,
            children: subchapters
                .filter((s) => s.parent_id === ch.id)
                .map((s) => ({
                    id: s.id,
                    title: s.title,
                    node_path: s.node_path,
                    passage_count: countMap[s.id] || 0,
                })),
        }))

        // 全量模式缓存
        if (!bookIds) {
            docTreeCache = tree
            docTreeCacheTime = Date.now()
        }

        return tree
    } catch (error) {
        log(`[docTree error] ${error.message}`)
        return null
    }
}

/**
 * llmRouteReasoning: LLM 动态目录推理
 * 当静态映射（rag_rule_doc_map）miss 时，用 LLM 分析查询文本 + 目录树，
 * 推理出应该去哪些章节搜索，返回相关段落 ID 列表
 *
 * @param {string} queryText - 缺陷描述/查询文本
 * @param {string} [noteQcCode] - 质控编码（可选，辅助推理）
 * @returns {Promise<{docIds: number[], passageIds: number[], reasoning: string}|null>}
 */
const llmRouteReasoning = async (queryText, noteQcCode) => {
    // 两级路由：先 SQL 粗筛书籍，再 LLM 精筛章节
    let bookIds = null
    let filteredBookTitles = null

    try {
        const coarseBookIds = await coarseFilterBooks(queryText, 10)
        if (coarseBookIds.length > 0) {
            bookIds = coarseBookIds
            // 获取书名用于日志
            const bookRows = await ragKnex.raw(
                `SELECT id, title FROM data.rag_source_doc WHERE id = ANY(?)`,
                [bookIds]
            )
            filteredBookTitles = bookRows.rows.map(r => r.title)
            log(`[llmRoute] 粗筛命中 ${bookIds.length} 本书: ${filteredBookTitles.join(', ')}`)
        }
    } catch (e) {
        log(`[llmRoute] 粗筛异常，降级为全量目录树: ${e.message}`)
    }

    // 获取目录树（粗筛命中则只取这些书的章节，否则全量）
    const tree = await getDocTree(bookIds)
    if (!tree || tree.length === 0) {
        log('[llmRoute] 目录树获取失败或为空，跳过 LLM 推理')
        return null
    }

    // 构造目录树摘要文本
    const scopeNote = filteredBookTitles
        ? `\n（已从全部书籍中筛选出以下 ${filteredBookTitles.length} 本最相关的书：${filteredBookTitles.join('、')}）\n`
        : ''

    const treeSummary = tree
        .map((cat) => {
            const childrenStr = cat.children
                .map((s) => `    - ${s.title} (nodeId=${s.id}, ${s.passage_count}条)`)
                .join('\n')
            return `- ${cat.title} [${cat.domain}] (nodeId=${cat.id})\n${childrenStr}`
        })
        .join('\n')

    const prompt = `你是一个医学质控知识检索助手。你的任务是根据用户的问题，判断应该去哪些知识章节中搜索答案。
${scopeNote}
## 知识目录树
${treeSummary}

## 用户问题
${queryText}
${noteQcCode ? `\n## 质控编码\n${noteQcCode}` : ''}

## 要求
1. 分析用户问题涉及的医学领域和知识点
2. 从目录树中选择最可能包含相关知识的 1~3 个章节（优先选 Level 2 子编码）
3. 简要说明推理过程

## 强制格式要求
- **必须**返回合法 JSON，不要有任何额外文本、markdown 代码块标记或解释
- selected_node_ids **必须**是数组，即使只选一个也要写成 [31]
- 如果完全不确定或找不到相关章节，selected_node_ids 返回空数组 []
- reasoning 字段不能为空，至少写一句话

## 回复示例（严格遵循此格式）
{"reasoning": "用户问入院记录书写要求，属于诊断检查类知识，应查A004章节", "selected_node_ids": [5]}

{"reasoning": "用户问题与任何章节均无明显关联", "selected_node_ids": []}`

    try {
        log(`[llmRoute] 开始推理, query="${queryText.slice(0, 50)}..."`)
        const response = await askLLM(prompt, 'star-fast', {
            expectFormat: 'json',
        })

        // 解析 LLM 返回
        let parsed
        if (typeof response === 'string') {
            try {
                parsed = JSON.parse(response)
            } catch {
                // 尝试从文本中提取 JSON
                const extractJson = require('extract-json-from-string')
                const extracted = extractJson(response)
                parsed = extracted?.[0] || extracted
            }
        } else {
            parsed = response
        }

        if (!parsed || !Array.isArray(parsed.selected_node_ids)) {
            log(`[llmRoute] LLM 返回格式异常: ${JSON.stringify(parsed).slice(0, 200)}`)
            return null
        }

        // 校验 selected_node_ids 是否为数字数组
        const validIds = parsed.selected_node_ids.filter(id => typeof id === 'number' && id > 0)
        if (validIds.length === 0) {
            log(`[llmRoute] LLM 返回的 selected_node_ids 无效: ${JSON.stringify(parsed.selected_node_ids)}`)
            return null
        }

        const selectedIds = validIds
        log(`[llmRoute] LLM 推理结果: nodes=${selectedIds}, reasoning="${parsed.reasoning}"`)

        // 根据选中节点查询关联的 doc_id 和 passage_ids
        // Level 2 节点本身就是 rag_source_doc.id，段落通过 doc_id 关联
        const passages = await ragKnex('rag_passage')
            .select('id', 'doc_id')
            .whereIn('doc_id', selectedIds)
            .andWhere('enabled', true)

        const docIdSet = new Set()
        const passageIdSet = new Set()
        for (const p of passages) {
            docIdSet.add(p.doc_id)
            passageIdSet.add(p.id)
        }

        // 如果选中的是 Level 1 节点，也要包含其子节点下的段落
        const level1Ids = selectedIds.filter((id) => tree.some((c) => c.id === id))
        if (level1Ids.length > 0) {
            const childIds = tree
                .filter((c) => level1Ids.includes(c.id))
                .flatMap((c) => c.children.map((s) => s.id))
            if (childIds.length > 0) {
                const childPassages = await ragKnex('rag_passage')
                    .select('id', 'doc_id')
                    .whereIn('doc_id', childIds)
                    .andWhere('enabled', true)
                for (const p of childPassages) {
                    docIdSet.add(p.doc_id)
                    passageIdSet.add(p.id)
                }
            }
        }

        const routeResult = {
            docIds: [...docIdSet],
            passageIds: [...passageIdSet],
            reasoning: parsed.reasoning || '',
        }

        // ── 自动回写 rag_rule_doc_map（下次同编码直接走 SQL，不再调 LLM） ──
        // 防幻觉验证：只有当目标书籍确实包含相关内容时才回写
        if (noteQcCode && routeResult.docIds.length > 0) {
            try {
                // 验证：检查选中书籍的段落是否与查询文本有词汇重叠
                // 关键词提取用与 coarseFilterBooks 相同的窗口策略（2/3/4字）：
                // 缺陷描述常是连续长句无标点，若只按空白切分，整句会变成一个关键词，
                // includes 永远匹配不上 → 该回写的不回写（误判为幻觉，map 永不积累）
                const stopWords2 = new Set(['患者', '需要', '选择', '处理', '管理', '诊断', '治疗', '入院', '急性', '并发', '合并'])
                const stopWords = new Set(['的', '了', '是', '在', '和', '与', '或', '及', '等', '应', '需', '为', '有', '不', '未', '对', '中', '上', '下', '该', '此', '怎么', '如何', '什么', '哪些', '多少'])
                const rawTokens = (queryText || '')
                    .replace(/[，。、；：！？\s,.;:!?\(\)\[\]（）【】]/g, ' ')
                    .split(/\s+/)
                    .filter((t) => t.length >= 2 && !stopWords.has(t))
            
                const queryKeywords = []
                const isChinese = (ch) => /[\u4e00-\u9fa5]/.test(ch)
                for (const token of rawTokens) {
                    if (token.length <= 4 || !isChinese(token[0])) {
                        queryKeywords.push(token)
                    } else {
                        for (let i = 0; i <= token.length - 2; i++) {
                            const w2 = token.slice(i, i + 2)
                            if (!stopWords2.has(w2)) queryKeywords.push(w2)
                            if (i <= token.length - 3) queryKeywords.push(token.slice(i, i + 3))
                            if (i <= token.length - 4) queryKeywords.push(token.slice(i, i + 4))
                        }
                    }
                }
            
                // 去重后取前 8 个（窗口提取会产生大量重叠词，需去重控制数量）
                const uniqueKeywords = [...new Set(queryKeywords)].slice(0, 8)
            
                let hasOverlap = false
                if (uniqueKeywords.length > 0 && routeResult.passageIds.length > 0) {
                    // 取前3个段落做抽样检查
                    const samplePassages = await ragKnex('rag_passage')
                        .select('content')
                        .whereIn('id', routeResult.passageIds.slice(0, 3))
            
                    const sampleText = samplePassages.map((p) => p.content || '').join(' ')
                    hasOverlap = uniqueKeywords.some((kw) => sampleText.includes(kw))
                } else {
                    // 无法验证时保守处理：不回写
                    hasOverlap = false
                }

                if (hasOverlap) {
                    for (const docId of routeResult.docIds) {
                        const exists = await ragKnex('rag_rule_doc_map')
                            .where({ note_qc_code: noteQcCode, doc_id: docId })
                            .first()
                        if (!exists) {
                            await ragKnex('rag_rule_doc_map').insert({
                                note_qc_code: noteQcCode,
                                doc_id: docId,
                                passage_ids: JSON.stringify(routeResult.passageIds),
                                relevance: 2,
                                source: 'llm_auto',
                                enabled: true,
                            })
                        }
                    }
                    log(`[llmRoute writeback] ${noteQcCode} → docs=[${routeResult.docIds}] 验证通过，已回写`)
                    setCachedRoute(noteQcCode, { docIds: routeResult.docIds, passageIds: routeResult.passageIds })
                } else {
                    log(`[llmRoute writeback] ${noteQcCode} → 验证未通过（书籍内容与查询无重叠），不回写（疑似LLM幻觉）`)
                }
            } catch (wbErr) {
                log(`[llmRoute writeback] 回写失败(不影响主流程): ${wbErr.message}`)
            }
        }

        return routeResult
    } catch (error) {
        log(`[llmRoute error] ${error.message}`)
        return null
    }
}

/**
 * expandDrugSynonyms: 药物同义词扩展
 * 检查关键词列表中是否包含药物名，如果是则扩展为所有同义词
 * 用于关键词搜索时，查询"罗氏芬"也能匹配到含"头孢曲松"的段落
 *
 * @param {string[]} keywords - 原始关键词列表
 * @returns {Promise<{keywords: string[], expansions: Object}>}
 *   keywords: 扩展后的关键词列表
 *   expansions: { 原始词: [同义词1, 同义词2, ...] } 用于日志
 */
const synonymCache = { data: null, time: 0 }
const SYNONYM_CACHE_TTL = 10 * 60 * 1000 // 10 分钟

const expandDrugSynonyms = async (keywords) => {
    // 加载同义词表（带缓存）
    if (!synonymCache.data || Date.now() - synonymCache.time > SYNONYM_CACHE_TTL) {
        try {
            const rows = await ragKnex('rag_drug_synonym')
                .select('canonical_name', 'synonyms')
                .where('enabled', true)
            synonymCache.data = rows
            synonymCache.time = Date.now()
        } catch (e) {
            log(`[synonym] 同义词表查询失败: ${e.message}`)
            return { keywords, expansions: {} }
        }
    }

    if (!synonymCache.data || synonymCache.data.length === 0) {
        return { keywords, expansions: {} }
    }

    const expansions = {}
    const extraKeywords = []

    for (const kw of keywords) {
        const kwLower = kw.toLowerCase()
        for (const row of synonymCache.data) {
            // 检查关键词是否匹配通用名或任何同义词
            const allNames = [row.canonical_name, ...row.synonyms]
            const matched = allNames.some(n => n.toLowerCase() === kwLower || kwLower.includes(n.toLowerCase()) || n.toLowerCase().includes(kwLower))
            if (matched && !expansions[kw]) {
                // 找到匹配，扩展所有同义词
                const expandedSynonyms = row.synonyms.filter(s => s.toLowerCase() !== kwLower)
                if (expandedSynonyms.length > 0) {
                    expansions[kw] = expandedSynonyms
                    extraKeywords.push(...expandedSynonyms)
                }
                break // 一个关键词只匹配一个药物
            }
        }
    }

    if (Object.keys(expansions).length > 0) {
        for (const [orig, syns] of Object.entries(expansions)) {
            log(`[synonym] "${orig}" → 扩展为: ${syns.join(', ')}`)
        }
    }

    return {
        keywords: [...keywords, ...extraKeywords],
        expansions,
    }
}

/**
 * keywordSearch: 关键词搜索（无向量，ILIKE 模糊匹配）
 * 从 queryText 中提取关键词，在 rag_passage.content 中做子串匹配
 * 适用于中文质控场景：用词规范，关键词精确匹配命中率高
 *
 * 中文分词策略：
 *   1. 按标点/空格拆分
 *   2. 长中文串（>4字）提取重叠 4 字窗口（如"入院记录书写"→["入院记录","记录书写"]）
 *   3. 严格模式（AND）优先，无结果时降级到宽松模式（OR + 匹配数排序）
 *
 * @param {string} queryText - 缺陷描述/查询文本
 * @param {number[]} [docIds] - 限定搜索范围的文档 ID（来自路由/LLM推理）
 * @param {number} [limitCount=3] - 返回条数上限
 * @returns {Promise<{id, doc_id, section_path, content}[]|null>}
 */
const keywordSearch = async (queryText, docIds, limitCount = 3) => {
    if (!queryText) return null

    // ── 关键词提取 ──
    const stopWords = new Set(['的', '了', '是', '在', '和', '与', '或', '及', '等', '应', '需', '为', '有', '不', '未', '对', '中', '上', '下', '内', '外', '该', '此', '其', '之'])

    // 按标点/空格拆分
    const rawTokens = queryText
        .replace(/[，。、；：！？\s,\.\;\:\!\?\(\)\[\]（）【】]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !stopWords.has(t))

    // 对长中文串提取重叠 4 字窗口
    const keywords = []
    const isChinese = (ch) => /[\u4e00-\u9fa5]/.test(ch)
    for (const token of rawTokens) {
        if (token.length <= 4 || !isChinese(token[0])) {
            keywords.push(token)
        } else {
            // 提取所有 4 字窗口
            for (let i = 0; i <= token.length - 4; i++) {
                keywords.push(token.slice(i, i + 4))
            }
        }
    }

    if (keywords.length === 0) {
        log('[keywordSearch] 无有效关键词，跳过')
        return null
    }

    log(`[keywordSearch] 原始关键词(${keywords.length}): ${keywords.join(', ')}`)

    // ── 药物同义词扩展 ──
    const originalKeywords = [...keywords]
    try {
        const { keywords: expandedKw, expansions } = await expandDrugSynonyms(keywords)
        if (Object.keys(expansions).length > 0) {
            keywords = expandedKw
            log(`[keywordSearch] 同义词扩展后(${keywords.length}): ${keywords.join(', ')}`)
        }
    } catch (e) {
        log(`[keywordSearch] 同义词扩展异常，使用原始关键词: ${e.message}`)
    }

    try {
        // ── 严格模式：原始关键词都要匹配（AND，不含同义词扩展） ──
        let strictQ = ragKnex('rag_passage')
            .select('id', 'doc_id', 'section_path', 'content')
            .andWhere('enabled', true)
            .limit(limitCount)

        for (const kw of originalKeywords) {
            strictQ = strictQ.whereRaw('content ILIKE ?', [`%${kw}%`])
        }
        if (docIds && docIds.length > 0) {
            strictQ = strictQ.whereIn('doc_id', docIds)
        }

        const strictResults = await strictQ
        if (strictResults.length > 0) {
            log(`[keywordSearch] 严格模式命中 ${strictResults.length} 条`)
            return strictResults
        }

        // ── 宽松模式：任一关键词匹配即可，按匹配数降序 ──
        log(`[keywordSearch] 严格模式无结果，降级宽松模式`)
        let relaxedQ = ragKnex('rag_passage')
            .select('id', 'doc_id', 'section_path', 'content')
            .andWhere('enabled', true)

        // 构造 OR 条件
        const orConditions = keywords.map((kw) => ragKnex.raw('content ILIKE ?', [`%${kw}%`]))
        relaxedQ = relaxedQ.where((builder) => {
            orConditions.forEach((cond, i) => {
                if (i === 0) builder.where(cond)
                else builder.orWhere(cond)
            })
        })

        if (docIds && docIds.length > 0) {
            relaxedQ = relaxedQ.whereIn('doc_id', docIds)
        }

        // 按匹配关键词数排序（命中越多越靠前）
        const scoreExpr = keywords
            .map((kw) => `CASE WHEN content ILIKE '%${kw}%' THEN 1 ELSE 0 END`)
            .join(' + ')
        relaxedQ = relaxedQ
            .select(ragKnex.raw(`(${scoreExpr}) AS kw_score`))
            .orderBy('kw_score', 'desc')
            .limit(limitCount)

        const relaxedResults = await relaxedQ
        if (relaxedResults.length > 0) {
            log(`[keywordSearch] 宽松模式命中 ${relaxedResults.length} 条`)
            // 去掉辅助评分字段
            return relaxedResults.map(({ kw_score, ...rest }) => rest)
        }

        log(`[keywordSearch] 宽松模式也无结果`)
        return null
    } catch (error) {
        log(`[keywordSearch error] ${error.message}`)
        return null
    }
}

/**
 * invalidateDocTreeCache: 清除目录树缓存
 */
const invalidateDocTreeCache = () => {
    docTreeCache = null
    docTreeCacheTime = 0
    log('[docTree cache invalidated]')
}

module.exports = {
    getPageRoute,
    pageIndexSearch,
    keywordSearch,
    expandDrugSynonyms,
    lookupIcdByQuery,
    coarseFilterBooks,
    invalidateRouteCache,
    getRouteCacheSize,
    llmRouteReasoning,
    getDocTree,
    invalidateDocTreeCache,
}
