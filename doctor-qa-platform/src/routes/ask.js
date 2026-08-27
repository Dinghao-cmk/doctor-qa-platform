/**
 * routes/ask.js - 医生问答 API 路由
 *
 * POST /api/ask
 * 请求体: {
 *   "question": "高血压诊断标准是什么？",
 *   "bookId": 102,        // 可选：限定搜索的书籍
 *   "docIds": [1,2],      // 可选：直接指定文档范围
 *   "sessionId": "abc",   // 可选：多轮对话会话ID
 *   "limit": 5,
 *   "skipLlm": false
 * }
 * 响应: { "answer": "...", "sources": [...], "meta": {...}, "sessionId": "..." }
 */
const express = require('express')
const debug = require('debug')
const crypto = require('crypto')

// 推荐书籍/上传书籍类问题：规则拦截，不检索不调 LLM（避免模型编造书单）
// 注意：单独"书"字仅跟在"推荐/介绍/上传"等明确动作词后匹配，避免误伤医学问题（如"哪些文书"）
const RECOMMEND_BOOK_RE = /(推荐|介绍|帮我|给我|上传|录入|收录|收入).{0,10}(书|书籍|教材|资料|指南|文献|书单)|(什么|哪些|几本|有什么).{0,6}(书籍|教材|资料|书单)/

// 医学领域分类关键词表（用于推荐时识别问题所属领域）
const DOMAIN_KEYWORDS = {
    '心血管': ['心衰', '心力衰竭', '高血压', '冠心病', '心肌梗死', '房颤', '心律失常', '血脂', '胸痛', '冠脉', '心绞痛', '动脉硬化'],
    '呼吸': ['肺炎', '哮喘', '慢阻肺', 'copd', '支气管', '肺栓塞', '呼吸衰竭', '咳嗽', '肺结核', '肺结节', '气胸'],
    '神经': ['卒中', '脑梗', '脑出血', '癫痫', '帕金森', '头痛', '眩晕', '面瘫', '痴呆', '蛛网膜', '脑炎', '脑积水'],
    '内分泌': ['糖尿病', '甲状腺', '甲亢', '甲减', '骨质疏松', '痛风', '尿酸', '胰岛素', '肾上腺', '垂体'],
    '消化': ['肝硬化', '肝炎', '胰腺炎', '胃炎', '溃疡', '肠炎', '消化道出血', '黄疸', '反流', '胆囊', '阑尾'],
    '肾脏': ['肾衰', '肾病', '透析', '肾小球', '尿毒症', '肌酐', '肾功能'],
    '血液': ['贫血', '白血病', '淋巴瘤', '血小板', '凝血', '血友病', '骨髓'],
    '感染': ['感染', '抗菌', '抗生素', '发热', '脓毒', '菌血症', '耐药', '结核', '病毒'],
    '肿瘤': ['肿瘤', '癌', '瘤', '化疗', '放疗', '靶向', '恶性'],
    '外科': ['手术', '创伤', '骨折', '阑尾炎', '疝', '胆结石', '痔', '烧伤', '关节', '外伤', '截肢'],
    '妇产': ['妊娠', '产科', '妇科', '月经', '分娩', '剖宫产', '宫颈', '胎盘'],
    '儿科': ['新生儿', '儿童', '小儿', '婴儿', '早产'],
    '急诊重症': ['心肺复苏', '休克', '中毒', '急救', '重症', '呼吸机', '除颤', '脓毒症', '多器官'],
    '影像检验': ['ct', 'mri', '超声', '影像', '检验', '实验室', '病理', 'x线', '内镜'],
    '口腔': ['口腔', '牙', '龋齿', '牙周', '牙龈', '种植牙', '正畸', '颌面'],
    '眼科': ['眼', '白内障', '青光眼', '视网膜', '近视', '角膜', '眼底', '视神经'],
    '耳鼻喉': ['耳', '鼻', '喉', '咽', '耳鸣', '中耳炎', '鼻炎', '扁桃体', '声带'],
    '皮肤': ['皮肤', '皮疹', '湿疹', '银屑病', '荨麻疹', '痤疮', '皮炎', '带状疱疹', '脱发'],
    '精神心理': ['抑郁', '焦虑', '失眠', '精神', '心理', '躁狂', '强迫', '幻听', '谵妄'],
    '康复': ['康复', '理疗', '物理治疗', '作业治疗', '吞咽训练', '运动疗法'],
    '风湿免疫': ['风湿', '类风湿', '红斑狼疮', '免疫', '干燥综合征', '痛风', '强直'],
    '骨科': ['骨', '关节', '脊柱', '腰椎', '颈椎', '骨折', '韧带', '半月板', '椎间盘'],
    '泌尿': ['泌尿', '前列腺', '膀胱', '尿路', '肾结石', '输尿管', '尿失禁', '精索'],
}

// 医学简称 → 全称别名（用于库内书名/章节匹配，解决"心衰"匹配不到"心力衰竭"的问题）
const MED_ALIASES = {
    '心衰': ['心力衰竭'],
    '心梗': ['心肌梗死'],
    '房颤': ['心房颤动'],
    '脑梗': ['脑梗死'],
    '慢阻肺': ['慢性阻塞性肺疾病'],
    'copd': ['慢性阻塞性肺疾病'],
    '呼衰': ['呼吸衰竭'],
    '肾衰': ['肾功能衰竭'],
    '冠心病': ['冠状动脉粥样硬化性心脏病'],
    '心功能不全': ['心力衰竭'],
}

// 识别问题所属医学领域
const classifyDomain = (question) => {
    const q = question.toLowerCase()
    for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
        if (kws.some(kw => q.includes(kw))) return domain
    }
    return null
}

// LLM 可选的领域枚举（与白名单领域一致；综合/教材/规范/药物中仅保留真实专科领域）
const LLM_DOMAINS = ['心血管', '呼吸', '神经', '内分泌', '消化', '肾脏', '血液', '感染', '肿瘤', '外科', '妇产', '儿科', '急诊重症', '影像检验', '药物', '口腔', '眼科', '耳鼻喉', '皮肤', '精神心理', '康复', '风湿免疫', '骨科', '泌尿']
const domainCache = new Map() // 问题 → 领域（避免重复调 LLM）
const DOMAIN_CACHE_MAX = 200

// LLM 辅助领域识别：关键词表未命中时兜底（只输出领域名，低幻觉风险；失败返回 null）
const classifyDomainWithLLM = async (question) => {
    const key = question.trim().slice(0, 30)
    if (domainCache.has(key)) return domainCache.get(key)
    try {
        const { model } = await settings.getLLM()
        const prompt = `你是医学信息分类助手。请判断以下医生提问属于哪个医学专科领域，从候选列表中选一个最合适的。
候选：${LLM_DOMAINS.join('、')}
只输出一个领域名，不要解释。都不合适时输出"其他"。
## 提问
${question.slice(0, 100)}`
        const answer = await callLLM([
            { role: 'system', content: '你只输出领域名称，不输出任何其他内容。' },
            { role: 'user', content: prompt },
        ], model, { temperature: 0, maxTokens: 50, timeoutMs: 8000 })
        const text = (answer || '').trim()
        const domain = LLM_DOMAINS.find(d => text.includes(d)) || null
        if (domainCache.size >= DOMAIN_CACHE_MAX) domainCache.clear()
        domainCache.set(key, domain)
        log(`[domain/llm] "${question.slice(0, 20)}..." → ${domain || '其他'}`)
        return domain
    } catch (error) {
        log(`[domain/llm] 识别失败: ${error.message}`)
        return null
    }
}

// 词条展开：简称 + 全称别名（提升库内标题匹配命中率）
const expandTerms = (terms) => {
    const out = []
    for (const t of terms) {
        out.push(t)
        const alias = MED_ALIASES[t.toLowerCase()]
        if (alias) out.push(...alias)
    }
    return out
}

// 生成固定回答：库内相关书 + 权威白名单书 + 上传引导（全部真实数据，LLM 不参与）
const buildBookGuideAnswer = async (question) => {
    const terms = expandTerms(segment(question).filter(t => !['书', '书籍', '推荐', '介绍'].includes(t)))
    const domain = classifyDomain(question) || await classifyDomainWithLLM(question)

    // 1. 库内匹配：段落分词命中查询词的启用书（段落挂在 level1/level2 两层，需分别追溯）
    let libBooks = []
    if (terms.length > 0) {
        const rows = await db.raw(`
            SELECT b.title, count(*) AS hits
            FROM data.rag_passage p
            JOIN data.rag_source_doc ch ON ch.id = p.doc_id
            JOIN data.rag_source_doc b ON b.id = ch.parent_id
            WHERE ch.level = 1 AND ch.enabled AND b.enabled AND b.level = 0
              AND p.content_terms && ?::text[]
            GROUP BY b.title
            UNION ALL
            SELECT b.title, count(*) AS hits
            FROM data.rag_passage p
            JOIN data.rag_source_doc ch ON ch.id = p.doc_id
            JOIN data.rag_source_doc l1 ON l1.id = ch.parent_id
            JOIN data.rag_source_doc b ON b.id = l1.parent_id
            WHERE ch.level = 2 AND ch.enabled AND l1.enabled AND b.enabled AND b.level = 0
              AND p.content_terms && ?::text[]
            GROUP BY b.title
        `, [terms, terms])
        // 合并 UNION 结果，按命中段落数排序
        const byBook = new Map()
        for (const r of rows.rows || rows) {
            byBook.set(r.title, (byBook.get(r.title) || 0) + Number(r.hits))
        }
        libBooks = [...byBook.entries()]
            .map(([title, hits]) => ({ title, hits }))
            .sort((a, b) => b.hits - a.hits)
            .slice(0, 5)
    }

    // 未覆盖闭环：知识库无相关内容时记录本次请求（管理员据此补充书目）
    if (libBooks.length === 0 && question.trim()) {
        await logUncoveredRequest(question, [], domain)
    }

    // 2. 白名单权威书（按领域）
    let wlBooks = []
    if (domain) {
        wlBooks = await db('rag_book_whitelist')
            .select('title', 'publisher', 'year', 'book_type')
            .where('domain', domain).andWhere('enabled', true)
            .orderBy('year', 'desc').limit(8)
    }

    // 3. 组装回答
    let parts = []
    if (libBooks.length > 0) {
        parts.push(`为您整理知识库内与"${question.slice(0, 40)}"相关的书籍，以及可参考的权威资料：`)
    } else {
        parts.push(`抱歉，知识库暂未收录与"${question.slice(0, 40)}"直接相关的内容，为您整理以下参考方向：`)
    }

    if (libBooks.length > 0) {
        parts.push('\n【📚 知识库现有书籍（可点书名直接提问）】')
        libBooks.forEach(b => parts.push(`- 《${b.title}》（命中 ${b.hits} 个相关段落）`))
    }

    if (wlBooks.length > 0) {
        parts.push(`\n【📖 权威参考书目（人工审核收录，真实可查）】`)
        wlBooks.forEach((b, i) => {
            const info = [b.publisher, b.year].filter(Boolean).join('，')
            parts.push(`${i + 1}. ${b.title}${info ? `（${info}）` : ''}`)
        })
        parts.push(`\n注：以上为该领域常用权威资料；若未覆盖您的具体问题，可在"📚 权威书目库"补充收录，或直接上传针对性资料。`)
    } else if (!domain) {
        parts.push('\n【📖 建议方向】该问题暂未匹配到具体医学领域，可优先查阅相关专科的临床指南与权威教材。')
    } else {
        parts.push(`\n【📖 建议方向】该问题属于${domain}领域，可查阅相关专科的最新临床指南与专家共识。`)
    }

    parts.push('\n【📤 上传书籍】点右上角"上传书籍"直接上传 PDF（支持 PDF/TXT/MD，约 2 秒入库），上传后即可直接提问。')
    parts.push('\n注：书目收录时间有限，最新版本以官方发布为准。')
    return parts.join('\n')
}

// 待补记录：知识库未收录的问题入库（供管理员补书），书籍建议非空时更新
const logUncoveredRequest = async (question, bookSuggestions = [], domain = '', note = '') => {
    if (!question || !question.trim()) return
    try {
        const sugg = bookSuggestions.slice(0, 5)
        const patch = {
            hit_count: db.raw('data.rag_book_request_log.hit_count + 1'),
            domain: domain || '',
            updated_at: db.raw('now()'),
        }
        if (note) patch.note = note.slice(0, 200)
        if (sugg.length > 0) patch.book_suggestions = JSON.stringify(sugg)
        await db('rag_book_request_log')
            .insert({
                question: question.trim().slice(0, 200),
                domain: domain || '',
                ...(note ? { note: note.slice(0, 200) } : {}),
                ...(sugg.length > 0 ? { book_suggestions: JSON.stringify(sugg) } : {}),
            })
            .onConflict('question')
            .merge(patch)
    } catch (e) { log(`[requestLog] 记录失败: ${e.message}`) }
}

// 覆盖不足检测：LLM 按 prompt 会如实说明“知识库中关于【XX】的内容有限”，
// 从回答中提取缺失方面 → 搜索相关书籍（可下载 PDF 优先）→ 记入待补清单（管理员据此补书）
const recordCoverageGap = async (question, answer, domain) => {
    if (!answer || answer.length < 30) return
    const m = answer.match(/关于[【「『“"'(]?([^】」』”"')，。；、]{1,30})[】」』”"')]?的内容有限/) || answer.match(/未涉及([^，。；、]{1,20})/)
    if (!m) return
    const gap = (m[1] || '').trim()
    if (!gap || gap.length > 30 || /^[\d\s]+$/.test(gap)) return

    // 附上缺失方面相关的书籍/指南（可下载 PDF 优先），供管理员直接下载补书；失败/超时不影响主记录
    let bookSug = []
    try {
        const webCfg = await settings.getWebSearch()
        if (webCfg.enabled) {
            // 搜索词：LLM 提炼 gap+问题 为核心医学词（如“体位 氧疗”），失败回退组合词
            const refined = await Promise.race([
                refineQuery(`${gap} ${question}`).catch(() => null),
                new Promise(res => setTimeout(() => res(null), 8000)),
            ])
            const searchTerm = refined && refined.trim().length >= 3
                ? refined.trim()
                : `${gap} ${question.replace(/[，。？！、；：\s]+/g, ' ').slice(0, 15)}`
            const books = await Promise.race([
                searchBooks(searchTerm, webCfg),
                new Promise(res => setTimeout(() => res([]), 10000)), // 10s 超时兑底，不阻塞响应
            ])
            bookSug = (books || []).slice(0, 3).map(r => ({
                title: r.title.slice(0, 120),
                link: r.link,
                snippet: (r.snippet || '').slice(0, 150),
                type: r.type || 'article',
            }))
        }
    } catch (e) {
        log(`[coverageGap] 书籍搜索失败: ${e.message}`)
    }
    await logUncoveredRequest(`[覆盖不足] ${question.trim().slice(0, 60)}`, bookSug, domain, `缺失内容：${gap}`)
}

// 对比实验模式（老板演示用）：
// - norag：无检索，DeepSeek 纯 LLM 直答（同模型控制变量，B 组）
// - weakrag：仅关键词检索（无向量/无重排/无保底），噪声直接喂 LLM（C 组）
// - local：无检索，本地模型直答（D 组，需设置里配置本地模型）
// - localrag：本地模型 + 完整混合检索（E 组，模型对照）
// - expModel：模型覆盖（对比实验选模型）：'deepseek-v4-pro' 或本地模型名/'local'
// 注意：不走缓存、不触发联网兑底/待补记录/覆盖不足，不污染闭环数据
// 提问前选模型：body.model 覆盖默认路由（''/auto → 路由；'local'或本地清单 → 本地端点；其他模型名 → 固定云端模型）
// 返回 null（不覆盖）或 { model, local, apiUrl?, apiKey? }
const resolveUserModel = async (req) => {
    const m = (req.body && req.body.model) || ''
    if (!m || m === 'auto') return null
    const local = await settings.getLocalLLM()
    const localModels = (await settings.get('llm_local_models', '')).split(',').map(s => s.trim()).filter(Boolean)
    const isLocal = m === 'local' || (local.model && m === local.model) || localModels.includes(m)
    if (isLocal) return { model: m === 'local' ? local.model : m, local: true, apiUrl: local.apiUrl, apiKey: local.apiKey }
    return { model: m, local: false }
}

const handleCompareMode = async (res, mode, question, history, sessionId, skipLlm, expModel = '', gpuStop = null) => {
    const start = Date.now()
    try {
        if (skipLlm) {
            return res.status(400).json({ error: '对比模式不支持 skipLlm', code: 'MODE_CONFLICT' })
        }
        // 本地模型清单（版本进步对比等场景：expModel 可指向任意本地模型，如 med-qa/med-r4-v5）
        const localModels = (await settings.get('llm_local_models', '')).split(',').map(s => s.trim()).filter(Boolean)
        const isLocalName = (name, local) => name === 'local' || (local.model && name === local.model) || localModels.includes(name)
        let answer = null
        let model = null
        let sources = []
        let searchCount = 0
        // 技术参数采集（对比实验看板）：token 消耗/提示词版本/端点/检索方式/引用统计
        let usage = null
        let promptVersion = null
        let endpoint = 'cloud'
        let searchMethod = 'none'

        if (mode === 'weakrag') {
            // C 组：仅关键词检索，直接取前几条（无向量/无重排/无保底，保留噪声效果）
            searchMethod = 'keyword'
            const raw = await keywordSearch(question, { limit: 6 })
            searchCount = raw.length
            sources = raw.slice(0, 5).map(r => ({
                id: r.id,
                docId: r.doc_id,
                docTitle: r.doc_title || '',
                bookTitle: r.bookTitle || '',
                sectionPath: r.section_path || '',
                pageNo: r.page_no,
                content: r.content,
                similarity: r.similarity || 0,
                matchType: r.source || 'keyword',
            }))
            // 实验模型覆盖：默认路由模型；'local'/本地模型名 → 本地端点
            const local = await settings.getLocalLLM()
            const isLocalModel = isLocalName(expModel, local)
            // expModel='local' → 默认本地模型；expModel=具体本地模型名（如 med-r4-v5）→ 用该模型；云端模型名 → 直接传给云端
            const chosenModel = isLocalModel ? (expModel === 'local' ? local.model : expModel) : (expModel || await pickModel({ question, bookCount: new Set(sources.map(s => s.bookTitle).filter(Boolean)).size, round: 1 }))
            const genOpts = { model: chosenModel }
            if (isLocalModel) { endpoint = 'local'; Object.assign(genOpts, { apiUrl: local.apiUrl, apiKey: local.apiKey, noFallback: true, timeoutMs: 180000 }) }
            genOpts.returnUsage = true // 采集 token 消耗
            const llmResult = await generateAnswer(question, sources, history, genOpts)
            if (llmResult) {
                answer = llmResult.answer
                model = llmResult.model
                usage = llmResult.usage
                promptVersion = llmResult.promptVersion
            }
        } else if (mode === 'local') {
            // D 组：本地模型直答（无检索）
            endpoint = 'local'
            const local = await settings.getLocalLLM()
            if (!local.apiUrl || !local.model) {
                return res.status(400).json({ error: '未配置本地模型（设置 → 本地模型（对照实验））', code: 'LOCAL_NOT_CONFIGURED' })
            }
            const direct = await generateDirectAnswer(question, history, local.model, { apiUrl: local.apiUrl, apiKey: local.apiKey }, { detailed: true, honest: true, returnUsage: true })
            if (direct) {
                answer = direct.answer
                model = direct.model
                usage = direct.usage
            }
        } else if (mode === 'localrag') {
            // E 组：本地微调模型 + 完整混合检索（模型对照实验：同样的知识库，不同模型生成）
            // 版本进步对比：expModel 可覆盖为其他本地模型（如 med-r4-v5）或云端模型（flash/pro）
            searchMethod = 'hybrid'
            const local = await settings.getLocalLLM()
            if (!local.apiUrl || !local.model) {
                return res.status(400).json({ error: '未配置本地模型（设置 → 本地模型（对照实验））', code: 'LOCAL_NOT_CONFIGURED' })
            }
            const results = await hybridSearch(question, {})
            searchCount = results.length
            sources = results.slice(0, 5).map(r => ({
                id: r.id,
                docId: r.doc_id,
                docTitle: r.doc_title || '',
                bookTitle: r.bookTitle || '',
                sectionPath: r.section_path || '',
                pageNo: r.page_no,
                content: r.content,
                similarity: r.similarity || 0,
                matchType: r.source || 'hybrid',
            }))
            // localrag 默认就是本地模型；expModel 可覆盖：'local'/本地模型名 → 本地端点，云端模型名 → 云端
            const isLocalModel = expModel ? isLocalName(expModel, local) : true
            endpoint = isLocalModel ? 'local' : 'cloud'
            const chosenModel = !isLocalModel ? expModel : (expModel && expModel !== 'local' ? expModel : local.model)
            const llmResult = await generateAnswer(question, sources, history, {
                model: chosenModel,
                ...(isLocalModel ? { apiUrl: local.apiUrl, apiKey: local.apiKey, timeoutMs: 180000 } : {}),
                noFallback: true, // 实验模式：失败不降级云端，保证变量纯净
                returnUsage: true, // 采集 token 消耗
            })
            if (llmResult) {
                answer = llmResult.answer
                model = llmResult.model
                usage = llmResult.usage
                promptVersion = llmResult.promptVersion
            }
        } else {
            // B 组：直答（无检索）；expModel 覆盖模型（对比实验选模型）
            const local = await settings.getLocalLLM()
            const isLocalModel = isLocalName(expModel, local)
            if (isLocalModel) endpoint = 'local'
            const chosenModel = isLocalModel ? (expModel === 'local' ? local.model : expModel) : (expModel || await pickModel({ question, bookCount: 0, round: 1 }))
            const direct = isLocalModel
                ? await generateDirectAnswer(question, history, chosenModel, { apiUrl: local.apiUrl, apiKey: local.apiKey }, { detailed: true, returnUsage: true })
                : await generateDirectAnswer(question, history, chosenModel, null, { returnUsage: true })
            if (direct) {
                answer = direct.answer
                model = direct.model
                usage = direct.usage
            }
        }

        if (!answer) {
            return res.status(502).json({ error: `${mode} 模式回答生成失败`, code: 'MODE_GEN_FAILED' })
        }
        addMessage(sessionId, 'user', question)
        addMessage(sessionId, 'assistant', answer)
        // 引用统计（[参考N] 合法性校验），老板看板用
        const citation = validateCitations(answer, sources.length)
        const bookCount = new Set(sources.map(s => s.bookTitle).filter(Boolean)).size
        // GPU 采样汇总（实验期间本机 GPU 指标；无 GPU/失败为 null）
        const gpu = gpuStop ? await gpuStop() : null
        return res.json({
            answer,
            sources,
            sessionId,
            meta: {
                question,
                model,
                mode,
                searchCount,
                finalCount: sources.length,
                bookCount,
                searchMethod,
                endpoint,
                answerLen: answer.length,
                duration: Date.now() - start,
                noResult: sources.length === 0,
                promptVersion,
                usage,
                gpu, // { name, utilAvg, utilPeak, memUsedMiB, memTotalMiB, memUtilPct, tempMin, tempMax, powerW, powerLimitW }
                citation: {
                    total: citation.refs.length,
                    invalid: citation.invalid,
                    coverage: Number(citation.coverage.toFixed(2)),
                },
            },
        })
    } catch (error) {
        log(`[ask/${mode}] 对比模式异常: ${error.message}`)
        return res.status(500).json({ error: '对比模式处理失败', code: 'INTERNAL_ERROR' })
    }
}

// 联网兜底（弱命中/话术命中时调用）：复用 answerViaWebSearch 完整链路（精炼+三路搜索+把关+权威优先）
// 返回 { answer, model, bookSuggestions } 或 null（未配置/失败均返回 null，调用方回退知识库链路）
const tryWebFallback = async (question, modelOverride = null) => {
    try {
        const webCfg = await settings.getWebSearch()
        if (!webCfg.enabled) return null
        const wa = await answerViaWebSearch(question, webCfg, modelOverride)
        return wa && wa.answer ? wa : null
    } catch (e) {
        log(`[webFallback] 联网兜底异常: ${e.message}`)
        return null
    }
}

// 联网搜索回答：搜索词精炼 + 三路搜索合并去重 → 相关度把关 → 同域名限量 → 权威优先 → LLM 作答
// 返回 { answer, model, bookSuggestions }；知识链路失败时 answer 为 null（由调用方回退）
const answerViaWebSearch = async (question, webCfg, modelOverride = null) => {
    try {
        // A. 搜索词精炼（LLM 提炼核心医学关键词；失败/耗时过长回退原问题）
        const refined = await Promise.race([
            refineQuery(question).catch(() => null),
            new Promise(res => setTimeout(() => res(null), 6000)),
        ]) || question
        const refinedOk = refined && refined !== question ? refined : question
        log(`[webSearch] 精炼搜索词: "${question.slice(0, 20)}..." → "${refinedOk.slice(0, 20)}"`)

        // B. 三路搜索：精炼词 / 精炼词+指南共识 / 原问题（召回互补）
        const queries = [refinedOk, `${refinedOk} 指南 共识`, question]
        const [rawResults, bookRaw] = await Promise.all([
            Promise.all(queries.map(q => searchGoogle(q, webCfg).catch(() => [])))
                .then(batches => dedupeByLink(batches.flat())),
            searchBooks(question, webCfg).catch(() => []),
        ])
        const bookSuggestions = bookRaw.slice(0, 3).map(r => ({
            title: r.title.slice(0, 120),
            link: r.link,
            snippet: (r.snippet || '').slice(0, 150),
            type: r.type || 'article',
        }))
        if (rawResults.length === 0) {
            log('[webSearch] 无搜索结果，回退通用兜底')
            return { answer: null, bookSuggestions }
        }
        const kept = await filterByRelevance(question, rawResults, webCfg.threshold)
        if (kept.length === 0) {
            log('[webSearch] 搜索结果全部低于相关度阈值，放弃联网回答（避免乱说）')
            return { answer: null, bookSuggestions }
        }
        // C. 同域名限量（信息面去重）→ 权威优先
        const deduped = dedupeByHost(kept, 2)
        const finalResults = prioritizeAuthoritative(deduped, 2)
        log(`[webSearch] 把关 ${kept.length} 条 → 域名去重 ${deduped.length} 条 → 最终 ${finalResults.length} 条`)
        const wa = await generateWebAnswer(question, finalResults, modelOverride)
        if (!wa) return { answer: null, bookSuggestions }
        return { answer: wa.answer, model: wa.model, bookSuggestions }
    } catch (error) {
        log(`[webSearch] 联网回答链路异常: ${error.message}`)
        return null
    }
}
const { hybridSearch, keywordSearch, ensureBookCoverage } = require('../services/search')
const { recordBadcase } = require('../services/badcase')
const { generateAnswer, generateFallbackAnswer, generateDirectAnswer, generateWebAnswer, refineQuery, streamAnswer, callLLM, PROMPT_VERSION } = require('../services/llm')
const { rerankResults, MAX_CANDIDATES } = require('../services/rerank')
const { validateCitations, shouldRetry } = require('../services/citation')
const { startSampling: startGpuSampling } = require('../services/gpuMonitor')
const { segment } = require('../services/tokenizer')
const { searchGoogle, searchBooks, filterByRelevance, prioritizeAuthoritative, dedupeByLink, dedupeByHost } = require('../services/webSearch')
const { pickModel } = require('../services/modelRouter')
const settings = require('../services/settings')
const cache = require('../services/cache')
const config = require('../config')
const { db } = require('../db')

const log = debug('qa:route')
const router = express.Router()

// ── 会话管理（内存） ──────────────────────────────────────
const sessions = new Map()
const SESSION_TTL = 24 * 60 * 60 * 1000 // 24 小时（多会话场景下用户可能隔一段时间切换回来）
const MAX_SESSION_MSGS = 60 // 最多保留 30 轮对话

const getSession = (sessionId) => {
    if (!sessionId) return null
    const session = sessions.get(sessionId)
    if (!session) return null
    if (Date.now() - session.time > SESSION_TTL) {
        sessions.delete(sessionId)
        return null
    }
    return session
}

const createSession = () => {
    const sessionId = crypto.randomUUID().slice(0, 8)
    sessions.set(sessionId, { messages: [], time: Date.now() })
    return sessionId
}

const addMessage = (sessionId, role, content) => {
    const session = sessions.get(sessionId)
    if (!session) return
    session.messages.push({ role, content })
    session.time = Date.now()
    if (session.messages.length > MAX_SESSION_MSGS) {
        session.messages.splice(0, session.messages.length - MAX_SESSION_MSGS)
    }
}

/**
 * 将 bookId 解析为该书及其全部子章节的 doc_id 列表
 */
const resolveBookDocIds = async (bookId) => {
    if (!bookId) return null
    try {
        const book = await db('rag_source_doc').select('id').where('id', bookId).andWhere('enabled', true).first()
        if (!book) {
            log(`[resolveBook] bookId=${bookId} 不存在或已禁用`)
            return [] // 空数组 = 书不存在（区别于解析异常的 null）
        }

        const level1s = await db('rag_source_doc').select('id').where('parent_id', bookId).andWhere('enabled', true)
        const level1Ids = level1s.map(d => d.id)

        let level2Ids = []
        if (level1Ids.length > 0) {
            const level2s = await db('rag_source_doc').select('id').whereIn('parent_id', level1Ids).andWhere('enabled', true)
            level2Ids = level2s.map(d => d.id)
        }

        const ids = [...new Set([bookId, ...level1Ids, ...level2Ids])]
        log(`[resolveBook] bookId=${bookId} → ${ids.length} 个 doc`)
        return ids
    } catch (error) {
        log(`[resolveBook] 解析失败: ${error.message}`)
        return null
    }
}

/**
 * 多轮追问的搜索词增强
 * 追问（如"那二级高血压呢？""怎么治疗？"）单独搜索会丢失上下文关键词，
 * 拼接最近 1~2 个用户问题作为搜索词，保证检索召回上下文主题
 * @param {string} question - 当前问题
 * @param {Object[]} history - 会话历史 [{role, content}]
 * @returns {string} 增强后的搜索词
 */
const buildSearchQuery = (question, history) => {
    if (!history || history.length === 0) return question
    // 取最近的用户问题（最多 2 个，跳过当前问题本身）
    const prevQuestions = []
    for (let i = history.length - 1; i >= 0 && prevQuestions.length < 2; i--) {
        const m = history[i]
        if (m.role === 'user' && typeof m.content === 'string' && m.content !== question) {
            prevQuestions.unshift(m.content)
        }
    }
    if (prevQuestions.length === 0) return question
    // 拼成 "高血压诊断标准是什么？ 那二级高血压呢？"
    const enhanced = [...prevQuestions, question].join(' ')
    log(`[ask] 追问增强搜索词: "${enhanced.slice(0, 60)}..." (${enhanced.length}字)`)
    return enhanced
}

/**
 * POST /api/ask - 医生提问主接口
 */
router.post('/ask', async (req, res) => {
    const startTime = Date.now()

    try {
        const { question, bookId, docIds, limit, threshold, skipLlm, sessionId: reqSessionId, regen, mode = '' } = req.body

        // 参数校验
        if (!question || typeof question !== 'string' || question.trim().length === 0) {
            return res.status(400).json({ error: '请提供有效的问题', code: 'INVALID_QUESTION' })
        }

        const trimmedQuestion = question.trim()
        if (trimmedQuestion.length > 500) {
            return res.status(400).json({ error: '问题长度不能超过500字', code: 'QUESTION_TOO_LONG' })
        }

        log(`[ask] 收到提问: "${trimmedQuestion.slice(0, 80)}"${reqSessionId ? ` (session=${reqSessionId})` : ''}`)

        // 会话上下文
        let sessionId = reqSessionId
        let isNewSession = false
        let history = []

        if (sessionId) {
            const s = getSession(sessionId)
            if (!s) {
                return res.status(400).json({ error: '会话已过期，请重新提问', code: 'SESSION_EXPIRED' })
            }
            history = s.messages
        } else {
            sessionId = createSession()
            isNewSession = true
        }

        // 缓存命中直接返回（仅无历史时使用缓存，避免多轮上下文错乱）
        // 注意：缓存 key 必须包含 bookId，否则选书搜索会命中全库缓存导致串书；mode 前缀隔离对比实验；model 覆盖维度隔离（同 mode 不同模型的实验不撞缓存）
        const expModel = (req.body && req.body.model) || '' // 对比实验：模型覆盖（''=路由默认）
        const cacheKey = (mode ? `m${mode}:` : '') + (expModel ? `x${expModel}:` : '') + (bookId ? `b${bookId}:` : '') + trimmedQuestion
        // regen=true（重新生成）时强制跳过缓存
        const cached = history.length === 0 && !regen ? cache.get(cacheKey) : null
        if (cached) {
            cached.meta.cached = true
            cached.sessionId = sessionId
            // 缓存命中也要写入会话历史（用户问题 + 缓存回答），否则后续追问上下文断裂
            addMessage(sessionId, 'user', trimmedQuestion)
            addMessage(sessionId, 'assistant', cached.answer)
            return res.json(cached)
        }

        // 解析搜索范围
        let searchDocIds = null
        if (Array.isArray(docIds) && docIds.length > 0) {
            searchDocIds = docIds
        } else if (bookId) {
            searchDocIds = await resolveBookDocIds(bookId)
            if (Array.isArray(searchDocIds) && searchDocIds.length === 0) {
                // 书不存在或已禁用：明确报错，不让用户误以为在限定范围
                return res.status(400).json({ error: `未找到书籍 ID=${bookId}，请刷新书籍列表后重新选择`, code: 'BOOK_NOT_FOUND' })
            }
            if (searchDocIds === null) {
                return res.status(500).json({ error: '书籍范围解析失败，请稍后重试', code: 'BOOK_RESOLVE_ERROR' })
            }
        }

        // 推荐书籍/上传书籍类问题：规则拦截（不检索不调 LLM，避免模型编造书单）
        if (RECOMMEND_BOOK_RE.test(trimmedQuestion)) {
            const answer = await buildBookGuideAnswer(trimmedQuestion)
            const noResult = {
                answer,
                sources: [],
                meta: {
                    question: trimmedQuestion,
                    model: null,
                    searchCount: 0,
                    noResult: true,
                    recommendRule: true, // 规则回答（非 LLM）
                    duration: Date.now() - startTime,
                },
                sessionId,
            }
            addMessage(sessionId, 'user', trimmedQuestion)
            addMessage(sessionId, 'assistant', answer)
            return res.json(noResult)
        }

        // 对比实验模式：norag（无检索纯 LLM）/ weakrag（仅关键词不重排不保底）/ local（本地模型无检索）/ localrag（本地模型+完整检索）
        // strong：完整 RAG 链路但强制强模型（不走路由，验证模型能力瓶颈）
        // 不走缓存命中（cacheKey 已带 mode 前缀隔离）、不污染闭环数据
        if (mode === 'norag' || mode === 'weakrag' || mode === 'local' || mode === 'localrag') {
            // 对比实验：GPU 采样包裹（finally 兕底 stop 防定时器泄漏；stop 幂等）
            const gpuSampler = await startGpuSampling()
            try {
                return await handleCompareMode(res, mode, trimmedQuestion, history, sessionId, skipLlm, expModel, gpuSampler.stop)
            } finally {
                await gpuSampler.stop().catch(() => {})
            }
        }

        // Step 1: 混合搜索（多轮追问时拼接历史问题增强搜索词，避免追问丢失上下文）
        const searchQuery = buildSearchQuery(trimmedQuestion, history)
        const searchResults = await hybridSearch(searchQuery, {
            docIds: searchDocIds,
            limit: limit || config.search.defaultLimit,
            threshold: threshold || config.search.similarityThreshold,
        })

        if (searchResults.length === 0) {
            // 知识库未命中：优先联网搜索回答（带相关度把关），未配置/失败再回退 LLM 通用知识
            let answer = '抱歉，未能在知识库中找到与您问题相关的内容。建议您换个表述方式提问，或上传相关书籍到知识库。'
            let model = null
            let fallbackUsed = false
            let webUsed = false
            let bookSug = []
            if (!skipLlm) {
                // 对比实验 mode=strong：联网兑底也用强模型，保证实验变量纯净
                const strongModelOverride = mode === 'strong' ? (await settings.getLLM()).strongModel : null
                // ① 联网搜索兜底（需配置 web_search_api_key）
                const webCfg = await settings.getWebSearch()
                if (webCfg.enabled) {
                    const wa = await answerViaWebSearch(trimmedQuestion, webCfg, strongModelOverride)
                    if (wa && wa.answer) {
                        answer = wa.answer
                        model = wa.model
                        fallbackUsed = true
                        webUsed = true
                    }
                    if (wa && wa.bookSuggestions) bookSug = wa.bookSuggestions
                }
                // ② 未配置/失败 → LLM 通用知识兑底（分级路由：复杂问题用强模型）
                if (!webUsed && (await settings.getLLM()).fallback) {
                    const fbModel = await pickModel({ question: trimmedQuestion, bookCount: 0, round: Math.floor(history.length / 2) + 1 })
                    const fb = await generateFallbackAnswer(trimmedQuestion, history, fbModel)
                    if (fb) {
                        answer = fb.answer
                        model = fb.model
                        fallbackUsed = true
                    }
                }
                // ③ 联网/云端都失败 → 本地微调模型兜底（诚实约束版：知识外明说不确定，不编造）
                if (!webUsed && !fallbackUsed) {
                    const local = await settings.getLocalLLM()
                    if (local.apiUrl && local.model) {
                        const localAns = await generateDirectAnswer(trimmedQuestion, history, local.model, { apiUrl: local.apiUrl, apiKey: local.apiKey }, { detailed: true, honest: true })
                        if (localAns && localAns.answer) {
                            answer = localAns.answer
                            model = `${localAns.model}（本地兑底）`
                            fallbackUsed = true
                        }
                    }
                }
            }
            // 未覆盖闭环：普通未收录问题也进入待补清单（带联网书籍建议）
            await logUncoveredRequest(trimmedQuestion, bookSug, classifyDomain(trimmedQuestion) || '')
            // 学习闭环：零命中样本入库（供扩充黄金题库/检索调参）
            await recordBadcase({ question: trimmedQuestion, reason: 'no_result', model, note: '知识库零命中' })
            const noResult = {
                answer,
                sources: [],
                meta: {
                    question: trimmedQuestion,
                    model,
                    searchCount: 0,
                    noResult: true,
                    fallback: fallbackUsed,
                    webSearch: webUsed,
                    duration: Date.now() - startTime,
                },
                sessionId,
            }
            addMessage(sessionId, 'user', trimmedQuestion)
            addMessage(sessionId, 'assistant', answer)
            return res.json(noResult)
        }

        // Step 1.5: LLM 重排序（过滤不相关段落，提升质量、省 token）
        let reranked = searchResults
        let evaluatedCount = 0
        let rerankLevel2 = null // LLM 判定“直接相关”的段落数（null=未判定/未执行）
        let rerankInfo = null // 重排过程明细（前端展示用）
        if (!skipLlm) {
            const rr = await rerankResults(trimmedQuestion, searchResults)
            reranked = rr.kept
            rerankLevel2 = rr.level2Count
            evaluatedCount = Math.min(searchResults.length, MAX_CANDIDATES) // rerank 实际评估的条数
            if (rr.details) {
                rerankInfo = {
                    candidateCount: searchResults.length,
                    evaluated: rr.details.length,
                    keptCount: rr.kept.length,
                    minLevel: config.rerank.minLevel,
                    details: rr.details.map(d => {
                        const src = searchResults[d.index - 1]
                        return {
                            ...d,
                            bookTitle: src?.bookTitle || src?.doc_title || '',
                            content: (src?.content || '').slice(0, 100),
                        }
                    }),
                }
            }
        }

        // Step 1.6: 按书保底（在重排之后执行：只从 rerank 未评估的候选中补书）
        // 顺序：先 rerank 过滤 → 再保底补书 → 送 LLM，避免两环节互相抵消
        const limitNum = limit || config.search.defaultLimit
        const finalSources = ensureBookCoverage(reranked, searchResults, limitNum, evaluatedCount)

        // 阶段一：弱命中预判（rerank 判定无“直接相关”段落 → 知识库实际不可用 → 自动联网兜底）
        // 联网失败/未配置回退知识库链路；regen 不重复联网
        let weakWeb = null
        let webUsed = false
        if (!skipLlm && rerankLevel2 === 0 && !regen) {
            // 学习闭环：弱命中样本入库（检索到段落但 rerank 判定无直接相关）
            await recordBadcase({ question: trimmedQuestion, reason: 'weak_hit', sources: searchResults, note: 'rerank level2=0' })
            const webCfg = await settings.getWebSearch()
            if (webCfg.enabled) {
                log(`[ask] 弱命中（level2=0）→ 尝试联网兜底`)
                weakWeb = await tryWebFallback(trimmedQuestion, mode === 'strong' ? (await settings.getLLM()).strongModel : null)
                webUsed = !!weakWeb
            }
        }

        // Step 2: LLM 生成回答（带多轮上下文 + 多模型分级路由 + 引用一致性校验）
        let answer = null
        let model = null
        let promptVersion = null
        let citationInfo = null
        let llmUsage = null // 用户指定模型时的 token 消耗（展示用）

        if (!skipLlm && !webUsed) {
            // 模型路由：默认按问题复杂度/命中书数/追问轮数选择快/强模型；提问前可选模型（body.model）覆盖
            const round = Math.floor(history.length / 2) + 1
            const bookCount = new Set(finalSources.map(s => s.bookTitle).filter(Boolean)).size
            const userModel = await resolveUserModel(req)
            // 对比实验 mode=strong：跳过路由，强制强模型（用户选择优先于 strong 实验）
            const chosenModel = userModel ? userModel.model : (mode === 'strong'
                ? (await settings.getLLM()).strongModel
                : await pickModel({
                    question: trimmedQuestion,
                    bookCount,
                    round,
                }))
            log(`[ask] 模型路由: ${chosenModel} (问题${trimmedQuestion.length}字/命中${bookCount}书/第${round}轮${userModel ? '/用户指定' : ''}${mode === 'strong' && !userModel ? '/实验强制强模型' : ''})`)

            const genOpts = { model: chosenModel }
            if (userModel && userModel.local) Object.assign(genOpts, { apiUrl: userModel.apiUrl, apiKey: userModel.apiKey, timeoutMs: 180000 })
            if (userModel) genOpts.returnUsage = true // 用户指定模型时采集 token 展示
            let llmResult = await generateAnswer(trimmedQuestion, finalSources, history, {
                ...genOpts,
                // 重新生成：换一种表述方式重新组织回答
                extraHint: regen ? '用户要求重新生成回答：请保持医学内容正确的前提下，用与上一次不同的结构和措辞重新组织回答，不要与原回答雷同。' : '',
            })
            if (llmResult) {
                // 引用一致性校验（规则层：非法编号移除 + 严重时重新生成）
                citationInfo = validateCitations(llmResult.answer, finalSources.length)
                if (shouldRetry(citationInfo)) {
                    log(`[ask] 引用非法编号 ${citationInfo.invalid.join(',')}，带修正指令重新生成`)
                    const retryResult = await generateAnswer(trimmedQuestion, finalSources, history, {
                        model: chosenModel,
                        extraHint: `注意：你上一次的回答引用了不存在的参考编号（${citationInfo.invalid.map(n => `[参考${n}]`).join('、')}）。请重新回答：每个 [参考N] 必须对应参考资料【参考N】的内容，只引用真实存在的编号，宁可少标不可标错。`,
                    })
                    if (retryResult) {
                        llmResult = retryResult
                        citationInfo = validateCitations(retryResult.answer, finalSources.length)
                        citationInfo.retried = true
                    }
                }
                answer = citationInfo.answer // 使用清理非法标注后的回答
                model = llmResult.model
                promptVersion = llmResult.promptVersion
                llmUsage = llmResult.usage || null
            }
        }

        // 弱命中联网成功：直接使用联网回答
        if (webUsed && weakWeb) {
            answer = weakWeb.answer
            model = weakWeb.model
        }

        // 阶段二：回答后话术兜底（捕获 rerank 未判定的弱命中：跳过重排/保底补入无关段等）
        // 知识库回答自行判定“未检索到相关内容” → 再试一次联网，成功则替换
        if (!webUsed && !skipLlm && answer && /知识库未检索到与问题相关的内容/.test(answer)) {
            const webCfg = await settings.getWebSearch()
            if (webCfg.enabled) {
                log(`[ask] 回答判定知识库无相关内容 → 联网兜底`)
                const wa = await tryWebFallback(trimmedQuestion, mode === 'strong' ? (await settings.getLLM()).strongModel : null)
                if (wa) {
                    answer = wa.answer
                    model = wa.model
                    webUsed = true
                    weakWeb = wa
                }
            }
        }

        // 弱命中联网成功：记入待补清单（知识库实际不可用，管理员据此补书）
        if (webUsed && weakWeb) {
            await logUncoveredRequest(trimmedQuestion, weakWeb.bookSuggestions || [], classifyDomain(trimmedQuestion) || '')
        }

        // 如果 LLM 失败或跳过，返回原文摘要
        if (!answer) {
            answer = finalSources
                .map((s, i) => `${i + 1}. ${s.content.slice(0, 200)}${s.content.length > 200 ? '...' : ''}`)
                .join('\n\n')
        }

        // 覆盖不足闭环：知识库命中但内容有限（如缺“体位”）→ 记入待补清单供管理员补书
        // 注意：此处必然是知识库链路（未命中分支已提前 return），不存在联网回答
        // 后台执行：内部含书籍搜索（最长 10s），不阻塞回答响应；失败静默不影响主流程
        recordCoverageGap(trimmedQuestion, answer, classifyDomain(trimmedQuestion) || '').catch(e => log(`[coverageGap] 后台执行异常: ${e.message}`))

        // Step 3: 组装响应
        const sources = webUsed ? [] : finalSources.map((s) => ({
            id: s.id,
            docId: s.docId,
            docTitle: s.docTitle,
            bookTitle: s.bookTitle || '',
            sectionPath: s.sectionPath,
            pageNo: s.pageNo,
            content: s.content,
            similarity: s.similarity,
            matchType: s.source,
        }))

        const result = {
            answer,
            sources,
            rerank: rerankInfo, // 重排过程明细（候选→级别→保留/删除），供前端展示
            meta: {
                question: trimmedQuestion,
                model,
                promptVersion,
                usage: llmUsage, // 用户指定模型时的 token 消耗
                searchCount: searchResults.length,
                rerankedCount: reranked.length,
                finalCount: webUsed ? 0 : finalSources.length,
                bookCount: webUsed ? 0 : new Set(finalSources.map(s => s.bookTitle).filter(Boolean)).size,
                noResult: webUsed ? true : (finalSources.length === 0), // 搜到但被 LLM 判定均不相关，同样视为未收录
                webSearch: webUsed, // 联网兜底回答标记（弱命中/话术命中后替换）
                round: Math.floor(history.length / 2) + 1, // 当前对话轮数（第几轮追问）
                citation: citationInfo
                    ? {
                        total: citationInfo.refs.length,
                        invalid: citationInfo.invalid,
                        coverage: Number(citationInfo.coverage.toFixed(2)),
                        fixed: citationInfo.fixed,
                        retried: !!citationInfo.retried,
                    }
                    : null,
                duration: Date.now() - startTime,
                newSession: isNewSession,
            },
            sessionId,
        }

        // 保存对话历史
        addMessage(sessionId, 'user', trimmedQuestion)
        addMessage(sessionId, 'assistant', answer)

        // 写入缓存（仅首轮无历史时缓存；key 含 bookId 避免串书）
        if (model && !skipLlm && history.length === 0) {
            cache.set(cacheKey, { ...result, sessionId: undefined })
        }

        res.json(result)
    } catch (error) {
        console.error(`[QA平台] 问答处理异常: ${error.message}`)
        log(`[ask error] ${error.stack}`)
        res.status(500).json({ error: '服务内部错误，请稍后重试', code: 'INTERNAL_ERROR' })
    }
})

/**
 * POST /api/ask/stream - 流式问答（SSE）
 * 事件流：stage(搜索/过滤/生成) → delta(回答增量) → done(完整结果)
 * 或 error(流内错误)；参数/会话校验失败直接返回 HTTP 400（与 /ask 一致）
 */
router.post('/ask/stream', async (req, res) => {
    const startTime = Date.now()
    const { question, bookId, docIds, limit, threshold, sessionId: reqSessionId, regen } = req.body

    // 前置校验（复用 /ask 的语义，失败返回 HTTP 400，前端可走现有重试逻辑）
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
        return res.status(400).json({ error: '请提供有效的问题', code: 'INVALID_QUESTION' })
    }
    const trimmedQuestion = question.trim()
    if (trimmedQuestion.length > 500) {
        return res.status(400).json({ error: '问题长度不能超过500字', code: 'QUESTION_TOO_LONG' })
    }

    let sessionId = reqSessionId
    let isNewSession = false
    let history = []
    if (sessionId) {
        const s = getSession(sessionId)
        if (!s) {
            return res.status(400).json({ error: '会话已过期，请重新提问', code: 'SESSION_EXPIRED' })
        }
        history = s.messages
    } else {
        sessionId = createSession()
        isNewSession = true
    }

    let searchDocIds = null
    if (Array.isArray(docIds) && docIds.length > 0) {
        searchDocIds = docIds
    } else if (bookId) {
        searchDocIds = await resolveBookDocIds(bookId)
        if (Array.isArray(searchDocIds) && searchDocIds.length === 0) {
            return res.status(400).json({ error: `未找到书籍 ID=${bookId}，请刷新书籍列表后重新选择`, code: 'BOOK_NOT_FOUND' })
        }
        if (searchDocIds === null) {
            return res.status(500).json({ error: '书籍范围解析失败，请稍后重试', code: 'BOOK_RESOLVE_ERROR' })
        }
    }

    // 开始 SSE 流
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    })
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

    try {
        // 缓存命中直接推 done
        const cacheKey = (bookId ? `b${bookId}:` : '') + trimmedQuestion
        const cached = history.length === 0 && !regen ? cache.get(cacheKey) : null
        if (cached) {
            cached.meta.cached = true
            cached.sessionId = sessionId
            addMessage(sessionId, 'user', trimmedQuestion)
            addMessage(sessionId, 'assistant', cached.answer)
            send({ type: 'done', ...cached })
            return res.end()
        }

        // 推荐书籍/上传书籍类问题：规则拦截（流式入口同样处理，避免模型编造书单）
        if (RECOMMEND_BOOK_RE.test(trimmedQuestion)) {
            const answer = await buildBookGuideAnswer(trimmedQuestion)
            const noResult = {
                answer,
                sources: [],
                meta: {
                    question: trimmedQuestion, model: null, searchCount: 0,
                    noResult: true, recommendRule: true, duration: Date.now() - startTime,
                },
                sessionId,
            }
            addMessage(sessionId, 'user', trimmedQuestion)
            addMessage(sessionId, 'assistant', answer)
            send({ type: 'done', ...noResult })
            return res.end()
        }

        // 搜索
        send({ type: 'stage', stage: 'search' })
        const searchQuery = buildSearchQuery(trimmedQuestion, history)
        const searchResults = await hybridSearch(searchQuery, {
            docIds: searchDocIds,
            limit: limit || config.search.defaultLimit,
            threshold: threshold || config.search.similarityThreshold,
        })

        if (searchResults.length === 0) {
            // 未命中：优先联网搜索回答（带相关度把关），未配置/失败再回退 LLM 通用知识
            let answer = '抱歉，未能在知识库中找到与您问题相关的内容。建议您换个表述方式提问，或上传相关书籍到知识库。'
            let model = null
            let fallbackUsed = false
            let webUsed = false
            let bookSug = []
            // ① 联网搜索兜底
            const webCfg = await settings.getWebSearch()
            if (webCfg.enabled) {
                const wa = await answerViaWebSearch(trimmedQuestion, webCfg)
                if (wa && wa.answer) { answer = wa.answer; model = wa.model; fallbackUsed = true; webUsed = true }
                if (wa && wa.bookSuggestions) bookSug = wa.bookSuggestions
            }
            // ② 未配置/失败 → LLM 通用知识兑底（分级路由：复杂问题用强模型）
            if (!webUsed && (await settings.getLLM()).fallback) {
                const fbModel = await pickModel({ question: trimmedQuestion, bookCount: 0, round: Math.floor(history.length / 2) + 1 })
                const fb = await generateFallbackAnswer(trimmedQuestion, history, fbModel)
                if (fb) { answer = fb.answer; model = fb.model; fallbackUsed = true }
            }
            // 未覆盖闭环：普通未收录问题也进入待补清单（带联网书籍建议）
            await logUncoveredRequest(trimmedQuestion, bookSug, classifyDomain(trimmedQuestion) || '')
            // 学习闭环：零命中样本入库（供扩充黄金题库/检索调参）
            await recordBadcase({ question: trimmedQuestion, reason: 'no_result', model, note: '知识库零命中' })
            const noResult = {
                answer,
                sources: [],
                meta: {
                    question: trimmedQuestion, model, searchCount: 0,
                    noResult: true, fallback: fallbackUsed, webSearch: webUsed,
                    duration: Date.now() - startTime,
                },
                sessionId,
            }
            addMessage(sessionId, 'user', trimmedQuestion)
            addMessage(sessionId, 'assistant', answer)
            send({ type: 'done', ...noResult })
            return res.end()
        }

        // 重排序 + 保底（流式接口始终执行重排）
        send({ type: 'stage', stage: 'rerank' })
        const rr = await rerankResults(trimmedQuestion, searchResults)
        const reranked = rr.kept
        const rerankLevel2 = rr.level2Count // null=未判定（候选≤2/重排失败），交给知识库链路
        const evaluatedCount = Math.min(searchResults.length, MAX_CANDIDATES)
        // 重排过程明细（前端展示：候选→级别→保留/删除），与非流式 /ask 一致
        let rerankInfo = null
        if (rr.details) {
            rerankInfo = {
                candidateCount: searchResults.length,
                evaluated: rr.details.length,
                keptCount: rr.kept.length,
                minLevel: config.rerank.minLevel,
                details: rr.details.map(d => {
                    const src = searchResults[d.index - 1]
                    return {
                        ...d,
                        bookTitle: src?.bookTitle || src?.doc_title || '',
                        content: (src?.content || '').slice(0, 100),
                    }
                }),
            }
        }
        const limitNum = limit || config.search.defaultLimit
        const finalSources = ensureBookCoverage(reranked, searchResults, limitNum, evaluatedCount)

        // 阶段一：弱命中预判（rerank 判定无“直接相关”段落 → 知识库实际不可用 → 自动联网兜底）
        // 联网回答一次性 done 输出（前端已验证：无 delta 时 done 正常渲染）；regen 不重复联网
        if (rerankLevel2 === 0 && !regen) {
            // 学习闭环：弱命中样本入库（检索到段落但 rerank 判定无直接相关）
            await recordBadcase({ question: trimmedQuestion, reason: 'weak_hit', sources: searchResults, note: 'rerank level2=0' })
            const webCfg = await settings.getWebSearch()
            if (webCfg.enabled) {
                log(`[ask/stream] 弱命中（level2=0）→ 联网兜底`)
                const wa = await tryWebFallback(trimmedQuestion)
                if (wa) {
                    // 记入待补清单（知识库实际不可用，管理员据此补书）
                    await logUncoveredRequest(trimmedQuestion, wa.bookSuggestions || [], classifyDomain(trimmedQuestion) || '')
                    const noResult = {
                        answer: wa.answer,
                        sources: [],
                        meta: {
                            question: trimmedQuestion, model: wa.model, searchCount: searchResults.length,
                            noResult: true, webSearch: true, duration: Date.now() - startTime,
                        },
                        sessionId,
                    }
                    addMessage(sessionId, 'user', trimmedQuestion)
                    addMessage(sessionId, 'assistant', wa.answer)
                    send({ type: 'done', ...noResult })
                    return res.end()
                }
            }
        }

        // 模型路由：默认按问题复杂度/命中书数/追问轮数选择；提问前可选模型（body.model）覆盖
        const round = Math.floor(history.length / 2) + 1
        const bookCount = new Set(finalSources.map(s => s.bookTitle).filter(Boolean)).size
        const userModel = await resolveUserModel(req)
        const chosenModel = userModel ? userModel.model : await pickModel({ question: trimmedQuestion, bookCount, round })
        log(`[ask/stream] 模型路由: ${chosenModel} (问题${trimmedQuestion.length}字/命中${bookCount}书/第${round}轮${userModel ? '/用户指定' : ''})`)

        // 流式生成
        send({ type: 'stage', stage: 'generate' })
        let llmResult = null
        let citationInfo = null
        const streamOpts = { model: chosenModel }
        if (userModel && userModel.local) Object.assign(streamOpts, { apiUrl: userModel.apiUrl, apiKey: userModel.apiKey, timeoutMs: 180000 })
        llmResult = await streamAnswer(trimmedQuestion, finalSources, history, {
            ...streamOpts,
            extraHint: regen ? '用户要求重新生成回答：请保持医学内容正确的前提下，用与上一次不同的结构和措辞重新组织回答，不要与原回答雷同。' : '',
        }, (delta) => send({ type: 'delta', text: delta }))

        if (llmResult) {
            citationInfo = validateCitations(llmResult.answer, finalSources.length)
            if (shouldRetry(citationInfo)) {
                log(`[ask/stream] 引用非法编号 ${citationInfo.invalid.join(',')}，带修正指令重新生成`)
                send({ type: 'stage', stage: 'generate' })
                const retryResult = await streamAnswer(trimmedQuestion, finalSources, history, {
                    model: chosenModel,
                    extraHint: `注意：你上一次的回答引用了不存在的参考编号（${citationInfo.invalid.map(n => `[参考${n}]`).join('、')}）。请重新回答：每个 [参考N] 必须对应参考资料【参考N】的内容，只引用真实存在的编号，宁可少标不可标错。`,
                }, (delta) => send({ type: 'delta', text: delta }))
                if (retryResult) {
                    llmResult = retryResult
                    citationInfo = validateCitations(retryResult.answer, finalSources.length)
                    citationInfo.retried = true
                }
            }
        }

        // 组装结果
        let answer = null
        let model = null
        let promptVersion = null
        if (llmResult) {
            answer = citationInfo.answer
            model = llmResult.model
            promptVersion = llmResult.promptVersion
        }
        if (!answer) {
            answer = finalSources
                .map((s, i) => `${i + 1}. ${s.content.slice(0, 200)}${s.content.length > 200 ? '...' : ''}`)
                .join('\n\n')
        }
        const sources = finalSources.map((s) => ({
            id: s.id, docId: s.docId, docTitle: s.docTitle, bookTitle: s.bookTitle || '',
            sectionPath: s.sectionPath, pageNo: s.pageNo, content: s.content,
            similarity: s.similarity, matchType: s.source,
        }))
        const result = {
            answer,
            sources,
            rerank: rerankInfo, // 重排过程明细（候选→级别→保留/删除），供前端展示
            meta: {
                question: trimmedQuestion, model, promptVersion,
                searchCount: searchResults.length, rerankedCount: reranked.length,
                finalCount: finalSources.length,
                bookCount: new Set(finalSources.map(s => s.bookTitle).filter(Boolean)).size,
                noResult: finalSources.length === 0,
                round, duration: Date.now() - startTime, newSession: isNewSession,
                citation: citationInfo
                    ? {
                        total: citationInfo.refs.length, invalid: citationInfo.invalid,
                        coverage: Number(citationInfo.coverage.toFixed(2)),
                        fixed: citationInfo.fixed, retried: !!citationInfo.retried,
                    }
                    : null,
            },
            sessionId,
        }

        addMessage(sessionId, 'user', trimmedQuestion)
        addMessage(sessionId, 'assistant', answer)
        if (model && history.length === 0 && !regen) {
            cache.set(cacheKey, { ...result, sessionId: undefined })
        }

        // 覆盖不足闭环（流式入口同样记录，供管理员补书）；后台执行不阻塞流结束
        recordCoverageGap(trimmedQuestion, answer, classifyDomain(trimmedQuestion) || '').catch(e => log(`[coverageGap] 后台执行异常: ${e.message}`))

        send({ type: 'done', ...result })
        res.end()
    } catch (error) {
        console.error(`[QA平台] 流式问答异常: ${error.message}`)
        log(`[ask/stream error] ${error.stack}`)
        send({ type: 'error', code: 'INTERNAL_ERROR', message: '服务内部错误，请稍后重试' })
        res.end()
    }
})

/**
 * GET /api/health - 健康检查
 */
router.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'doctor-qa-platform',
        timestamp: new Date().toISOString(),
    })
})

/**
 * GET /api/books - 获取知识库书籍列表（供前端筛选）
 */
router.get('/books', async (req, res) => {
    try {
        const books = await db('rag_source_doc')
            .select('id', 'title', 'domain', 'keywords')
            .where('level', 0)
            .andWhere('enabled', true)
            .orderBy('id')

        res.json({ books })
    } catch (error) {
        log(`[books error] ${error.message}`)
        res.status(500).json({ error: '获取书籍列表失败' })
    }
})

/**
 * GET /api/session/clear - 清空会话（调试用）
 */
router.get('/session/clear', (req, res) => {
    sessions.clear()
    res.json({ cleared: true, count: sessions.size })
})

/**
 * GET /api/cache/clear - 清空问答缓存（知识库更新后调用，避免旧答案）
 */
router.get('/cache/clear', (req, res) => {
    cache.clear()
    res.json({ cleared: true, ...cache.stats() })
})

/**
 * GET /api/cache/stats - 缓存统计
 */
router.get('/cache/stats', (req, res) => {
    res.json(cache.stats())
})

module.exports = router
