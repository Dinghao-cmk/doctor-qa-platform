/**
 * search.js - 混合搜索服务
 * 结合向量相似度搜索 + 关键词 ILIKE 搜索，返回最相关的知识段落
 */
const debug = require('debug')
const config = require('../config')
const settings = require('./settings')
const { db } = require('../db')
const { generateEmbedding } = require('./embedding')
const { segment } = require('./tokenizer')

const log = debug('qa:search')

/**
 * 向量相似度搜索
 * @param {number[]} queryVec - 查询向量
 * @param {Object} options
 * @param {number[]} [options.docIds] - 限定搜索的文档范围
 * @param {number} [options.limit] - 返回条数
 * @param {number} [options.threshold] - 相似度阈值
 * @returns {Promise<Object[]>}
 */
const vectorSearch = async (queryVec, { docIds, limit = 5, threshold = 0.5 } = {}) => {
    if (!queryVec || queryVec.length === 0) return []

    try {
        const vecStr = `[${queryVec.join(',')}]`

        let sql = `
            SELECT
                p.id,
                p.doc_id,
                p.section_path,
                p.page_no,
                p.content,
                1 - (p.embedding <=> ?::vector) AS similarity,
                d.title AS doc_title,
                COALESCE(bk.title, ch.title, d.title) AS book_title
            FROM data.rag_passage p
            LEFT JOIN data.rag_source_doc d ON d.id = p.doc_id
            LEFT JOIN data.rag_source_doc ch ON ch.id = d.parent_id
            LEFT JOIN data.rag_source_doc bk ON bk.id = ch.parent_id
            WHERE p.enabled = true
              AND p.embedding IS NOT NULL
              AND 1 - (p.embedding <=> ?::vector) >= ?
        `
        const params = [vecStr, vecStr, threshold]

        if (docIds && docIds.length > 0) {
            sql += ` AND p.doc_id = ANY(?)`
            params.push(docIds)
        }

        sql += ` ORDER BY p.embedding <=> ?::vector LIMIT ?`
        params.push(vecStr, limit)

        const res = await db.raw(sql, params)
        const results = res.rows || []
        log(`[vectorSearch] 命中 ${results.length} 条`)
        return results
    } catch (error) {
        log(`[vectorSearch] 错误: ${error.message}`)
        return []
    }
}

/**
 * 提取加权医学关键词（统一入口，三处共用：keywordSearch / 标题回退 / 章节路径回退）
 * 权重：完整词组3 > "的"拆分词组3 > 4字窗口2 > 2字窗口1
 * @param {string} queryText - 查询文本
 * @returns {Map<string, number>} 关键词 → 权重
 */
const extractKeywords = (queryText) => {
    const stopWords = new Set([
        '的', '了', '是', '在', '和', '与', '或', '及', '等', '应', '需', '为',
        '有', '不', '未', '对', '中', '上', '下', '该', '此', '其', '之',
        '怎么', '如何', '什么', '哪些', '多少', '可以', '能否', '是否',
    ])

    const kwWeights = new Map() // 关键词 → 权重（完整词组3 > 4字词组2 > 2字词1）
    const addKw = (kw, weight) => {
        if (!kw || kw.length < 2) return
        kwWeights.set(kw, Math.max(kwWeights.get(kw) || 0, weight))
    }

    // 1. 按标点/空格拆分为词组
    const rawTokens = queryText
        .replace(/[【】、。，；：！？\s,.;:!\(\)\[\]（）【】""''"]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2)

    for (const token of rawTokens) {
        // 2. 含"的"的分割："社区获得性肺炎的诊断标准" → "社区获得性肺炎" + "诊断标准"（权重3）
        if (token.includes('的')) {
            const parts = token.split(/[的]/).filter(p => p.length >= 2)
            for (const p of parts) addKw(p, 3)
        }
        // 3. 整体词组（权重3）
        if (!stopWords.has(token)) addKw(token, 3)
        // 4. 滑动窗口4字词组 step=2（权重2）
        const chars = [...token]
        for (let i = 0; i + 4 <= chars.length; i += 2) {
            addKw(chars.slice(i, i + 4).join(''), 2)
        }
        // 5. 滑动窗口2字全覆盖（权重1）
        for (let i = 0; i + 2 <= chars.length; i++) {
            const sub = chars.slice(i, i + 2).join('')
            if (sub.length === 2 && /[\u4e00-\u9fa5]/.test(sub[0])) {
                addKw(sub, 1)
            }
        }
    }

    return kwWeights
}

// 命中词数加权表达式（3字以上特异词计2分单命中可过门槛，2字泛词计1分需凑2个）
const hitScoreExpr = (termsPlaceholder = '?') =>
    `COALESCE((SELECT sum(CASE WHEN length(t) >= 3 THEN 2 ELSE 1 END) FROM unnest(p.content_terms) AS t WHERE t = ANY(${termsPlaceholder})), 0)`

/**
 * 关键词搜索（jieba 分词 + GIN 数组索引）
 * 段落入库时已分词存 content_terms，查询分词后做数组重叠匹配
 * @param {string} queryText - 查询文本
 * @param {Object} options
 * @param {number[]} [options.docIds] - 限定搜索的文档范围
 * @param {number} [options.limit] - 返回条数
 * @returns {Promise<Object[]>}
 */
const keywordSearch = async (queryText, { docIds, limit = 5 } = {}) => {
    if (!queryText) return []

    const terms = segment(queryText)
    if (terms.length === 0) {
        log('[keywordSearch] 分词无有效词，回退 ILIKE 搜索')
        return keywordSearchIlike(queryText, { docIds, limit })
    }
    const queryTerms = terms.slice(0, 20)
    log(`[keywordSearch] 分词(${queryTerms.length}): ${queryTerms.slice(0, 10).join(', ')}`)

    try {
        // 主检索：content_terms 数组重叠（任一词命中即进入候选），加权命中数排序
        const scoreExpr = hitScoreExpr()
        const perBook = Math.max(2, Math.ceil(limit / 3))

        const sub = db('rag_passage as p')
            .select(
                'p.id',
                'p.doc_id',
                'p.section_path',
                'p.page_no',
                'p.content',
                'd.title as doc_title',
                db.raw('COALESCE(bk.title, ch.title, d.title) AS book_title'),
                db.raw(`${scoreExpr} AS kw_score`, [queryTerms]),
                db.raw(`ROW_NUMBER() OVER (PARTITION BY COALESCE(bk.title, ch.title, d.title) ORDER BY ${scoreExpr} DESC) AS book_rn`, [queryTerms])
            )
            .leftJoin('rag_source_doc as d', 'd.id', 'p.doc_id')
            .leftJoin('rag_source_doc as ch', 'ch.id', 'd.parent_id')
            .leftJoin('rag_source_doc as bk', 'bk.id', 'ch.parent_id')
            .where('p.enabled', true)
            // 数组重叠走 GIN 索引（Bitmap Index Scan），避免全表扫描
            .whereRaw(`p.content_terms && ?::text[]`, [queryTerms])
            // 多词命中门槛：加权分 ≥2（1 个 4 字词 或 2 个 2 字词），过滤碎片词噪音
            .whereRaw(`${scoreExpr} >= 2`, [queryTerms])

        if (docIds && docIds.length > 0) {
            sub.whereIn('p.doc_id', docIds)
        }

        const query = db(sub.as('t'))
            .select('t.*')
            .where('t.book_rn', '<=', perBook)
            .orderBy('t.kw_score', 'desc')
            .limit(limit)

        const results = await query
        if (results.length === 0) {
            // 分词检索无命中，回退 ILIKE（处理切词差异导致的漏检，如新词/专有名词）
            log('[keywordSearch] 分词检索无命中，回退 ILIKE 搜索')
            return keywordSearchIlike(queryText, { docIds, limit })
        }
        log(`[keywordSearch] 命中 ${results.length} 条（每书最多${perBook}条）`)
        return results.map(({ kw_score, book_title, ...rest }) => ({ ...rest, similarity: null, matchScore: kw_score, bookTitle: book_title || '' }))
    } catch (error) {
        log(`[keywordSearch] 错误: ${error.message}`)
        return []
    }
}

/**
 * 关键词搜索（ILIKE 模糊匹配，分词不可用时的回退路径）
 * 从查询文本中提取关键词，在段落内容中做子串匹配
 */
const keywordSearchIlike = async (queryText, { docIds, limit = 5 } = {}) => {
    if (!queryText) return []

    // 关键词提取（公共函数，权重：完整词组3 > 4字词组2 > 2字词1）
    const kwWeights = extractKeywords(queryText)
    // 长查询（>30字符）过滤掉大量2字碎片，优先保留>=3字关键词
    const isLongQuery = queryText.length > 30
    let uniqueKeywords = [...kwWeights.keys()].filter(k => k.length >= 2)
    if (isLongQuery) {
        // 长查询：只保留 >=3 字 + 权重最高的前10个2字词
        const longKws = uniqueKeywords.filter(k => k.length >= 3)
        const shortKws = uniqueKeywords
            .filter(k => k.length === 2)
            .sort((a, b) => (kwWeights.get(b) || 0) - (kwWeights.get(a) || 0))
            .slice(0, 10)
        uniqueKeywords = [...new Set([...longKws, ...shortKws])]
    }
    // 关键词总数上限 25（优先保留高权重、更长的关键词）
    if (uniqueKeywords.length > 25) {
        uniqueKeywords.sort((a, b) => (kwWeights.get(b) || 0) - (kwWeights.get(a) || 0) || b.length - a.length)
        uniqueKeywords = uniqueKeywords.slice(0, 25)
    }
    if (uniqueKeywords.length === 0) return []

    log(`[keywordSearchIlike] 关键词(${uniqueKeywords.length}): ${uniqueKeywords.slice(0, 15).join(', ')}`)

    try {
        // 宽松模式：任一关键词匹配，按加权命中数排序
        // 权重：完整词组3 > 4字2 > 2字1，同分场景下高权重词区分度更好
        const scoreExpr = uniqueKeywords
            .map((kw) => `CASE WHEN p.content ILIKE '%${kw}%' THEN ${kwWeights.get(kw) || 1} ELSE 0 END`)
            .join(' + ')

        // 按书分组取 top（窗口函数）：每本书独立排序取前 perBook 条，
        // 避免单本书重复段落多而霸占候选（如 J18 同一内容 10 份重复）
        const perBook = Math.max(2, Math.ceil(limit / 3))

        const sub = db('rag_passage as p')
            .select(
                'p.id',
                'p.doc_id',
                'p.section_path',
                'p.page_no',
                'p.content',
                'd.title as doc_title',
                db.raw('COALESCE(bk.title, ch.title, d.title) AS book_title'),
                db.raw(`(${scoreExpr}) AS kw_score`),
                db.raw(`ROW_NUMBER() OVER (PARTITION BY COALESCE(bk.title, ch.title, d.title) ORDER BY (${scoreExpr}) DESC) AS book_rn`)
            )
            .leftJoin('rag_source_doc as d', 'd.id', 'p.doc_id')
            .leftJoin('rag_source_doc as ch', 'ch.id', 'd.parent_id')
            .leftJoin('rag_source_doc as bk', 'bk.id', 'ch.parent_id')
            .where('p.enabled', true)
            // 多词命中门槛：加权分 ≥2 才进候选（命中1个词组/4字词 或 2个2字词），
            // 过滤只沾一个碎片词（如"什么""是"）的噪音段落
            .whereRaw(`(${scoreExpr}) >= 2`)

        if (docIds && docIds.length > 0) {
            sub.whereIn('p.doc_id', docIds)
        }

        const query = db(sub.as('t'))
            .select('t.*')
            .where('t.book_rn', '<=', perBook)
            .orderBy('t.kw_score', 'desc')
            .limit(limit)

        const results = await query
        log(`[keywordSearchIlike] 命中 ${results.length} 条（每书最多${perBook}条）`)
        return results.map(({ kw_score, book_title, ...rest }) => ({ ...rest, similarity: null, matchScore: kw_score, bookTitle: book_title || '' }))
    } catch (error) {
        log(`[keywordSearchIlike] 错误: ${error.message}`)
        return []
    }
}

/**
 * 混合搜索（主入口）
 * 向量搜索 + 关键词搜索，合并去重后返回
 * @param {string} queryText - 医生提问文本
 * @param {Object} options
 * @param {number[]} [options.docIds] - 限定文档范围
 * @param {number} [options.limit] - 返回条数
 * @param {number} [options.threshold] - 向量相似度阈值
 * @returns {Promise<Object[]>} 合并后的搜索结果
 */
const hybridSearch = async (queryText, options = {}) => {
    log(`[hybridSearch] query="${queryText.slice(0, 50)}", limit=${options.limit || config.search.defaultLimit}`)

    const { results, fusion } = await runPipeline(queryText, options)

    const bookSummary = [...new Set(results.map(r => r.bookTitle || '其他'))].join(', ')
    log(`[hybridSearch] 返回候选 ${results.length} 条，涉及 ${new Set(results.map(r => r.bookTitle || '其他')).size} 本书: ${bookSummary}`)
    log(`[hybridSearch] 融合参数: k=${fusion.rrfK}, weights=${JSON.stringify(fusion.weights)}`)
    return results
}

/**
 * 单条检索结果标准化（三路字段统一为融合条目结构）
 */
const toStandard = (raw, fallbackSource) => ({
    id: raw.id,
    docId: raw.doc_id,
    docTitle: raw.doc_title || '',
    bookTitle: raw.book_title || raw.bookTitle || raw.doc_title || '',
    sectionPath: raw.section_path || '',
    pageNo: raw.page_no,
    content: raw.content,
    similarity: raw.similarity != null ? parseFloat(raw.similarity) || 0 : null,
    matchScore: raw.matchScore || raw.kw_score || null,
    source: fallbackSource,
})

/**
 * RRF 融合排序（Reciprocal Rank Fusion）
 * 多通道检索结果按“排名”融合，替代硬编码优先级排序：
 *   score(id) = Σ_c w_c / (k + rank_c(id))
 * - rank 为条目在通道内部排序中的位置（1 起），跨通道分数天然可比（不混比相似度/权重）
 * - 同一条目被多通道命中时自动叠加分数（等价于原“both”加权，但权重可学习、可配置）
 * - k 与通道权重均由配置驱动（qa_settings.search_fusion / env），无硬编码
 * @param {Object} channels - { vector: [], keyword: [], title: [], path: [] }，每路已按相关度降序
 * @param {Object} fusion - { rrfK, weights: { vector, keyword, title, path } }
 * @returns {Object[]} 按融合分降序的结果（含 rrfScore / source 标记）
 */
const rrfFuse = (channels, fusion) => {
    const k = fusion.rrfK > 0 ? fusion.rrfK : 60
    const weights = fusion.weights || {}

    const acc = new Map() // id → { item, score, channels: Set }
    for (const [name, list] of Object.entries(channels)) {
        if (!list || list.length === 0) continue
        const w = weights[name]
        if (w !== undefined && w <= 0) continue // 显式配 0 = 关闭该通道
        const wv = w === undefined ? 1 : w // 未配置的通道默认权重 1
        list.forEach((item, idx) => {
            const rank = idx + 1
            if (!acc.has(item.id)) acc.set(item.id, { item, score: 0, channels: new Set() })
            const entry = acc.get(item.id)
            entry.score += wv / (k + rank)
            entry.channels.add(name)
        })
    }

    return [...acc.values()]
        .map(e => ({
            ...e.item,
            rrfScore: Number(e.score.toFixed(6)),
            source: e.channels.size > 1 ? 'both' : e.item.source,
        }))
        .sort((a, b) => b.rrfScore - a.rrfScore)
}

/**
 * 按书配额 + 内容前缀去重（对融合排序后的列表执行）
 * 配额避免单本书霸占候选，去重避免近乎重复的段落同时入选
 */
const quotaAndDedup = (sorted, limit) => {
    // 按书配额：每本书最多保留 maxPerBook 条
    const maxPerBook = Math.max(2, Math.ceil(limit / 2))
    const bookCounts = new Map()
    const quotaFiltered = []
    for (const item of sorted) {
        const book = item.bookTitle || '其他'
        const cnt = bookCounts.get(book) || 0
        if (cnt < maxPerBook) {
            quotaFiltered.push(item)
            bookCounts.set(book, cnt + 1)
        }
    }

    // 内容去重：保留内容差异显著的段落，去除几乎重复的
    const deduped = []
    for (const item of quotaFiltered) {
        let isDuplicate = false
        for (const existing of deduped) {
            const minLen = Math.min(item.content.length, existing.content.length)
            if (minLen < 10) continue
            let common = 0
            for (let i = 0; i < minLen && item.content[i] === existing.content[i]; i++) common++
            if (common / minLen > 0.6) {
                isDuplicate = true
                break
            }
        }
        if (!isDuplicate) deduped.push(item)
    }
    return deduped
}

/**
 * 检索流水线（hybridSearch 与自学习调参脚本共用同一套逻辑）
 * 流程：三路并行检索 → RRF 融合 → 配额/去重 → 结果不足时章节路径兜底并重新融合
 * 融合参数可外部注入（options.fusion），供调参脚本在离线场景快速扫描参数组合
 * @returns {Promise<{results: Object[], channels: Object, fusion: Object}>}
 */
const runPipeline = async (queryText, options = {}, fusionOverride = null) => {
    const { docIds = null, limit = config.search.defaultLimit, threshold = 0.5 } = options
    const fusion = fusionOverride || (await settings.getSearchFusion())

    // 提前提取关键词（标题搜索 / 章节路径兜底共用，避免重复计算）
    const kwWeights = extractKeywords(queryText)
    const kwList = [...kwWeights.keys()].filter(k => k.length >= 2)

    // 并行执行向量搜索 + 关键词搜索 + 标题搜索（PageIndex 主动融合：标题不再被动回退，而是参与主检索）
    const [vectorResults, keywordResults, titleResults] = await Promise.all([
        (async () => {
            // 查询侧加 bge 指令前缀，提升检索相关性
            const queryVec = await generateEmbedding(queryText, { isQuery: true })
            if (!queryVec) {
                log('[hybridSearch] 向量生成失败，仅使用关键词搜索')
                return []
            }
            // 阈值自适应回退：主阈值无结果时降级到 vectorFallback 再试一次，避免候选不足
            let results = await vectorSearch(queryVec, { docIds, limit: limit + 2, threshold })
            if (results.length === 0 && threshold > fusion.vectorFallback) {
                log(`[hybridSearch] 向量无命中，阈值降级 ${threshold} → ${fusion.vectorFallback} 重试`)
                results = await vectorSearch(queryVec, { docIds, limit: limit + 2, threshold: fusion.vectorFallback })
            }
            return results
        })(),
        keywordSearch(queryText, { docIds, limit: limit * 3 }),
        titleSearch(queryText, { limit, docIds }, kwList),
    ])

    const channels = {
        vector: vectorResults.map(r => toStandard(r, 'vector')),
        keyword: keywordResults.map(r => toStandard(r, 'keyword')),
        title: titleResults.map(r => toStandard(r, 'title')),
    }

    // RRF 融合 + 配额 + 去重
    let fused = rrfFuse(channels, fusion)
    let pipeline = quotaAndDedup(fused, limit)

    // ── 章节路径兜底：内容不足时搜 section_path 补充，作为第四通道重新融合 ──
    const pathKw = [...kwWeights.keys()].filter(k => k.length >= 3).slice(0, 6)
    if (pipeline.filter(d => d.content && d.content.length > 5).length < 3 && pathKw.length > 0) {
        const pathResults = await sectionPathSearch(queryText, { limit: limit * 2, docIds }, pathKw)
        if (pathResults.length > 0) {
            log(`[hybridSearch] 章节路径补充 ${pathResults.length} 条并重新融合`)
            channels.path = pathResults.map(r => toStandard(r, 'path'))
            fused = rrfFuse(channels, fusion)
            pipeline = quotaAndDedup(fused, limit)
        }
    }

    // 返回全部去重候选（不做按书保底）
    // 保底改由 ensureBookCoverage 在 LLM 重排之后执行：
    // 先 rerank 过滤不相关段落，再从被删候选里补回每本书最相关的 1 条，避免两个环节互相抵消
    return { results: pipeline.slice(0, 20), channels, fusion }
}

/**
 * 按书保底（在 LLM 重排之后执行）
 * rerank 过滤后，某些书可能被全部删掉；从被删的候选中补回每本书最相关的 1 条
 * 保证：代教要求 "涉及到的每本书都要至少出一条"，且不与 rerank 的过滤互相抵消
 * @param {Object[]} kept - rerank 保留的结果（按相关性顺序）
 * @param {Object[]} candidates - 全部候选（已按相关性排序）
 * @param {number} limit - 最终条数上限
 * @param {number} evaluatedCount - rerank 已评估的候选数（前 N 条中未被保留的视为 LLM 明确判定不相关，不补）
 * @returns {Object[]}
 */
const ensureBookCoverage = (kept, candidates, limit = 5, evaluatedCount = 0) => {
    const result = [...kept]
    const coveredBooks = new Set(result.map(s => s.bookTitle || '其他'))
    const keptIds = new Set(result.map(s => s.id))
    // 只从 rerank 未评估的候选（第 evaluatedCount 条之后）补书：
    // 被评估过但被删除的段落是 LLM 明确判定不相关的，不补回（避免与 rerank 互相抵消）
    for (let i = evaluatedCount; i < candidates.length; i++) {
        const item = candidates[i]
        if (result.length >= limit) break
        if (keptIds.has(item.id)) continue
        const book = item.bookTitle || '其他'
        if (!coveredBooks.has(book)) {
            result.push(item)
            coveredBooks.add(book)
            keptIds.add(item.id)
        }
    }
    return result.slice(0, limit)
}

/**
 * 文档标题搜索（PageIndex 回退策略）
 * 复用 keywordSearch 的关键词列表，在 rag_source_doc 标题中搜索
 */
const titleSearch = async (queryText, { limit = 5, docIds: scopeDocIds = null } = {}, keywords) => {
    if (!queryText || !keywords || keywords.length === 0) return []

    try {
        const baseQuery = (builder) => {
            builder.where('enabled', true)
            if (scopeDocIds && scopeDocIds.length > 0) {
                builder.whereIn('id', scopeDocIds) // 限定搜索范围（选书模式）
            }
        }

        const matchedDocs = await db('rag_source_doc')
            .select('id', 'title', 'level', 'parent_id')
            .where(baseQuery)
            .andWhere((builder) => {
                keywords.forEach((kw, i) => {
                    if (kw.length < 4) return // 只匹配 4 字及以上的关键词（避免 2 字误配）
                    if (i === 0) builder.whereRaw('title ILIKE ?', [`%${kw}%`])
                    else builder.orWhereRaw('title ILIKE ?', [`%${kw}%`])
                })
            })
            .orderBy('level', 'desc')
            .limit(8)

        if (matchedDocs.length === 0) {
            // 宽匹配：用 2 字关键词再试一次
            const broadMatch = keywords.filter(k => k.length >= 2).slice(0, 5)
            const broadResult = await db('rag_source_doc')
                .select('id', 'title', 'level', 'parent_id')
                .where(baseQuery)
                .andWhere((builder) => {
                    broadMatch.forEach((kw, i) => {
                        if (i === 0) builder.whereRaw('title ILIKE ?', [`%${kw}%`])
                        else builder.orWhereRaw('title ILIKE ?', [`%${kw}%`])
                    })
                })
                .orderByRaw('CASE WHEN level=2 THEN 0 ELSE 1 END')
                .limit(8)
            if (broadResult.length === 0) return []
            matchedDocs.push(...broadResult)
        }

        // 去重（同个文档只保留一次）
        const unique = new Map()
        for (const d of matchedDocs) unique.set(d.id, d)
        const docs = [...unique.values()]

        log(`[titleSearch] 文档标题命中 ${docs.length} 条: ${docs.map(d => d.title).join(', ')}`)

        // 取这些文档的段落（JOIN 书名：保证回退补充的段落 bookTitle 是真实书名）
        const docIds = docs.map(d => d.id)
        const passages = await db('rag_passage as p')
            .select(
                'p.id', 'p.doc_id', 'p.section_path', 'p.page_no', 'p.content',
                'd.title as doc_title',
                db.raw('COALESCE(bk.title, ch.title, d.title) AS book_title')
            )
            .leftJoin('rag_source_doc as d', 'd.id', 'p.doc_id')
            .leftJoin('rag_source_doc as ch', 'ch.id', 'd.parent_id')
            .leftJoin('rag_source_doc as bk', 'bk.id', 'ch.parent_id')
            .where('p.enabled', true)
            .whereIn('p.doc_id', docIds)
            .limit(limit)

        if (passages.length > 0) return passages

        // 段落为空时取子文档的段落（Level 1 命中则找其 Level 2 子节点）
        const parentIds = docs.filter(d => d.level === 1).map(d => d.id)
        if (parentIds.length > 0) {
            const children = await db('rag_source_doc').select('id').whereIn('parent_id', parentIds).andWhere('enabled', true)
            const childIds = children.map(c => c.id)
            if (childIds.length > 0) {
                return await db('rag_passage as p')
                    .select(
                        'p.id', 'p.doc_id', 'p.section_path', 'p.page_no', 'p.content',
                        'd.title as doc_title',
                        db.raw('COALESCE(bk.title, ch.title, d.title) AS book_title')
                    )
                    .from('rag_passage as p').leftJoin('rag_source_doc as d', 'd.id', 'p.doc_id')
                    .leftJoin('rag_source_doc as ch', 'ch.id', 'd.parent_id')
                    .leftJoin('rag_source_doc as bk', 'bk.id', 'ch.parent_id')
                    .where('p.enabled', true).whereIn('p.doc_id', childIds).limit(limit)
            }
        }

        return passages
    } catch (error) {
        log(`[titleSearch] 错误: ${error.message}`)
        return []
    }
}

/**
 * 章节路径搜索（第三层回退）
 * 当段落内容和文档标题都搜不到时，尝试搜 section_path
 * 解决："心血管疾病"可匹配到 section_path 中含"心血管"的段落
 */
const sectionPathSearch = async (queryText, { limit = 5, docIds: scopeDocIds = null } = {}, keywords) => {
    if (!queryText || !keywords || keywords.length === 0) return []

    // 取较长的关键词（>=3字），短词在路径中太容易误匹配
    const pathKw = keywords.filter(k => k.length >= 3).slice(0, 8)
    if (pathKw.length === 0) return []

    try {
        let query = db('rag_passage as p')
            .select(
                'p.id', 'p.doc_id', 'p.section_path', 'p.page_no', 'p.content',
                'd.title as doc_title',
                db.raw('COALESCE(bk.title, ch.title, d.title) AS book_title')
            )
            .leftJoin('rag_source_doc as d', 'd.id', 'p.doc_id')
            .leftJoin('rag_source_doc as ch', 'ch.id', 'd.parent_id')
            .leftJoin('rag_source_doc as bk', 'bk.id', 'ch.parent_id')
            .where('p.enabled', true)

        // 限定搜索范围（选书模式：不跨书）
        if (scopeDocIds && scopeDocIds.length > 0) {
            query = query.whereIn('p.doc_id', scopeDocIds)
        }

        const results = await query
            .andWhere((builder) => {
                pathKw.forEach((kw, i) => {
                    if (i === 0) builder.whereRaw('p.section_path ILIKE ?', [`%${kw}%`])
                    else builder.orWhereRaw('p.section_path ILIKE ?', [`%${kw}%`])
                })
            })
            .limit(limit)

        if (results.length > 0) {
            log(`[sectionPathSearch] 命中 ${results.length} 条`)
        }
        return results
    } catch (error) {
        log(`[sectionPathSearch] 错误: ${error.message}`)
        return []
    }
}

module.exports = { hybridSearch, runPipeline, rrfFuse, quotaAndDedup, vectorSearch, keywordSearch, titleSearch, sectionPathSearch, ensureBookCoverage, extractKeywords }
