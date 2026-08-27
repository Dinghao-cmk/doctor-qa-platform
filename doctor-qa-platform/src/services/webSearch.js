/**
 * webSearch.js - 联网搜索服务（未收录问题时联网检索，带相关度把关）
 *
 * 流程：Serper(Google) 搜索 → embedding 相似度过滤 → 返回高相关结果
 * 安全设计：embedding 不可用时退化为关键词重叠把关；全部不相关则返回空（放弃联网回答）
 */
const debug = require('debug')
const superagent = require('superagent')
const { generateEmbedding } = require('./embedding')
const { segment } = require('./tokenizer')

const log = debug('qa:websearch')

// 余弦相似度
const cosineSim = (a, b) => {
    if (!a || !b || a.length !== b.length) return 0
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        na += a[i] * a[i]
        nb += b[i] * b[i]
    }
    if (na === 0 || nb === 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Serper(Google) 搜索（不限域名，白名单来源打权威标记，交给后续把关与排序）
 * @returns {Promise<Array<{title,link,snippet,authoritative}>>} 失败返回 []
 */
const searchGoogle = async (query, { apiKey, apiUrl, domains }) => {
    if (!apiKey) return []
    const payload = { q: query.slice(0, 100), num: 10, gl: 'cn', hl: 'zh-cn' }
    try {
        const res = await superagent
            .post(apiUrl)
            .set('X-API-KEY', apiKey)
            .send(payload)
            .timeout({ response: 12000 })
        const organic = res.body?.organic || []
        const results = organic.map(r => ({
            title: String(r.title || '').slice(0, 200),
            link: String(r.link || ''),
            snippet: String(r.snippet || '').slice(0, 400),
            // 白名单域名来源打标（后续排序优先，但不硬过滤）
            authoritative: domains.some(d => String(r.link || '').includes(d)),
        })).filter(r => r.link)
        log(`[search] "${query.slice(0, 20)}..." → ${results.length} 条原始结果`)
        return results
    } catch (error) {
        log(`[search] 搜索失败: ${error.message}`)
        return []
    }
}

/**
 * 权威优先排序：白名单来源靠前，非权威来源限量（防硬凑但允许补充）
 * 白名单未配置/无命中时：不截断，按相似度直接取（“全部来源”模式）
 */
const prioritizeAuthoritative = (results, maxNonAuth = 2) => {
    const auth = results.filter(r => r.authoritative)
    if (auth.length === 0) return results.slice(0, 5) // 全部来源模式：按相似度排序后取前 5
    const non = results.filter(r => !r.authoritative).slice(0, maxNonAuth)
    return [...auth, ...non].slice(0, 5)
}

/**
 * 按链接去重（多路搜索合并后使用，保留先出现的）
 */
const dedupeByLink = (results) => {
    const seen = new Set()
    return results.filter(r => {
        if (!r.link || seen.has(r.link)) return false
        seen.add(r.link)
        return true
    })
}

/**
 * 同域名限量（信息面去重：同一站点最多保留 maxPerHost 条，避免 LLM 反复读相似内容）
 */
const dedupeByHost = (results, maxPerHost = 2) => {
    const count = new Map()
    const out = []
    for (const r of results) {
        let host = ''
        try { host = new URL(r.link).hostname } catch { host = r.link }
        const c = count.get(host) || 0
        if (c >= maxPerHost) continue
        count.set(host, c + 1)
        out.push(r)
    }
    return out
}

/**
 * 相关度把关：embedding 相似度优先，退化时用关键词重叠
 * @returns {Promise<Array>} 过滤后的结果（按相似度降序）
 */
const filterByRelevance = async (query, results, threshold = 0.45) => {
    if (results.length === 0) return []
    const qVec = await generateEmbedding(query, { isQuery: true })
    const scored = []
    if (qVec) {
        // embedding 可用：逐个计算相似度（结果少，串行即可）
        for (const r of results) {
            const text = `${r.title}。${r.snippet}`
            const vec = await generateEmbedding(text)
            const sim = cosineSim(qVec, vec)
            scored.push({ ...r, sim })
        }
    } else {
        // embedding 不可用：关键词重叠把关（问题核心词至少命中 1 个）
        const terms = segment(query).filter(t => t.length >= 2)
        for (const r of results) {
            const text = `${r.title}${r.snippet}`
            const hits = terms.filter(t => text.includes(t)).length
            scored.push({ ...r, sim: hits > 0 ? 0.5 + Math.min(hits / 3, 0.4) : 0 })
        }
    }
    const kept = scored.filter(r => r.sim >= threshold).sort((a, b) => b.sim - a.sim)
    log(`[filter] 阈值 ${threshold}: ${scored.length} → ${kept.length} 条通过`)
    return kept
}

/**
 * 书籍搜索：搜可下载 PDF 的指南/共识/教材（供待补清单推荐）
 * 三路：filetype:pdf 指南共识 / 教材版本 / 通用书籍；PDF 链接优先，图书信息页兜底
 * @returns {Promise<Array<{title,link,snippet,type}>>} type: 'pdf'|'book'|'article'
 */
const searchBooks = async (query, cfg) => {
    const q = query.slice(0, 30)
    // 三路书籍查询：PDF 指南共识 / 教材 / 通用
    const queries = [
        `${q} filetype:pdf 指南 OR 共识`,
        `${q} 教材 第\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u7248`,
        `${q} 书籍 PDF 下载`,
    ]
    const batches = await Promise.all(queries.map(x => searchGoogle(x, cfg).catch(() => [])))
    const results = dedupeByLink(batches.flat())
    if (results.length === 0) return []

    // 类型判定与打分：PDF 直链最优先，教材次之，指南/共识再次
    const scored = results.map(r => {
        const link = r.link || ''
        const title = r.title || ''
        let type = 'article'
        let score = 0
        const isPdf = link.includes('.pdf') || /filetype:pdf|PDF/.test(title)
        if (isPdf) { type = 'pdf'; score += 3 }
        if (/第[一二三四五六七八九十\d]+版/.test(title) || /教材|教科书|课本/.test(title)) { type = 'book'; score += 2 }
        else if (/指南|共识|规范|手册|临床路径/.test(title)) { score += 1 } // 指南网页版：加分但不改变类型
        if (/科普|百科|问答|怎么|如何/.test(title)) score -= 2 // 弱化科普/问答类
        return { ...r, type, score }
    })

    // 按分数排序，取分数最高的；再按相关度把关（放宽阈值，PDF 直链优先）
    const top = scored.sort((a, b) => b.score - a.score).slice(0, 10)
    const filtered = await filterByRelevance(query, top, Math.min(cfg.threshold, 0.45))
    // 混合排序：PDF/教材优先于纯文章
    return filtered
        .sort((a, b) => (a.type === 'article' ? 0 : 1) - (b.type === 'article' ? 0 : 1) || b.score - a.score)
        .slice(0, 5)
        .map(r => ({ title: r.title.slice(0, 120), link: r.link, snippet: (r.snippet || '').slice(0, 150), type: r.type }))
}

module.exports = { searchGoogle, searchBooks, filterByRelevance, prioritizeAuthoritative, dedupeByLink, dedupeByHost, cosineSim }
