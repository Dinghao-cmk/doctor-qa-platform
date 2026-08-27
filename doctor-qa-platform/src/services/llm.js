/**
 * llm.js - LLM 回答生成服务
 * 基于检索到的知识段落，调用大模型生成通俗易懂的回答
 *
 * v2 变更：
 * - prompt 版本化（PROMPT_VERSION），回答 meta 可追溯
 * - 分类模板：按问题类型（诊断/治疗/药物/鉴别/通用）差异化约束输出
 * - few-shot 示例：规范回答格式
 * - 引用约束：每个 [参考N] 必须对应参考资料【参考N】，反幻觉
 * - 模型可注入：generateAnswer 支持指定模型（多模型分级路由），强模型失败自动降级快模型
 */
const debug = require('debug')
const superagent = require('superagent')
const http = require('http')
const https = require('https')
const config = require('../config')
const settings = require('./settings')

const log = debug('qa:llm')

// prompt 版本号（改动 prompt 时递增，便于评测对比）
const PROMPT_VERSION = 'v3'

// 多轮历史压缩预算（控制上下文 token，避免历史回答挤占当前回答空间）
const HISTORY_BUDGET = 2000 // 历史总字符预算（30轮长对话下保留最近多轮）
const ASSISTANT_MAX = 200 // 单条回答截断上限

/**
 * 压缩多轮历史：assistant 回答截断 + 总预算控制（从最近往回取）
 * @param {Object[]} history - 原始历史 [{role, content}]
 * @returns {Object[]} 压缩后的历史
 */
const compactHistory = (history) => {
    if (!history || history.length === 0) return []
    const compacted = []
    let total = 0
    for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i]
        let content = typeof m.content === 'string' ? m.content : ''
        if (m.role === 'assistant' && content.length > ASSISTANT_MAX) {
            content = content.slice(0, ASSISTANT_MAX) + '…'
        }
        if (total + content.length > HISTORY_BUDGET) break // 超预算丢弃更早的
        compacted.unshift({ role: m.role, content })
        total += content.length
    }
    return compacted
}

/**
 * 问题分类：判断提问类型，用于差异化模板
 * @param {string} question
 * @returns {'diagnosis'|'treatment'|'drug'|'differential'|'general'}
 */
const classifyQuestion = (question) => {
    if (/(鉴别|区分|如何区分)/.test(question)) return 'differential'
    if (/(诊断|标准|分型|分级|分期|定义|分类|依据)/.test(question)) return 'diagnosis'
    if (/(治疗|用药|方案|干预|处理|管理|防治|控制)/.test(question)) return 'treatment'
    if (/(药|剂量|用法|禁忌|不良反应|副作用)/.test(question)) return 'drug'
    return 'general'
}

// 分类模板：不同提问类型的输出约束
const TYPE_RULES = {
    diagnosis: `- 诊断/标准类：必须给出具体标准、数值或阈值，不要泛泛而谈
- 如涉及分型/分级/分期，按类别逐条说明判断依据`,
    treatment: `- 治疗类：按"治疗原则 → 分层/阶梯方案 → 注意事项"的结构回答
- 明确起始方案与调整策略，涉及药物给出药物类别和代表药，不堆砌药名`,
    drug: `- 药物类：必须区分适应症、禁忌症、常规剂量、注意事项
- 剂量给出常规范围，提醒需个体化调整`,
    differential: `- 鉴别类：从病因、临床表现、辅助检查等维度逐条对比
- 明确指出最有鉴别意义的检查或特征`,
    general: `- 先直接给出答案/标准，再简要说明`,
}

/**
 * 构建 RAG 问答 Prompt（v2）
 * @param {string} question - 医生提问
 * @param {Object[]} sources - 检索到的知识段落
 * @param {string} [extraHint] - 附加指令（如重试修正提示）
 * @returns {string}
 */
const buildPrompt = (question, sources, extraHint = '') => {
    const contextText = sources
        .map((s, i) => {
            const source = s.docTitle ? `《${s.docTitle}》` : '未知来源'
            const section = s.sectionPath ? ` ${s.sectionPath}` : ''
            return `【参考${i + 1}】${source}${section}
${s.content}`
        })
        .join('\n---\n\n')

    const type = classifyQuestion(question)
    const typeRule = TYPE_RULES[type] || TYPE_RULES.general

    return `你是一名临床医学知识助手，根据参考资料回答医生的问题。

## 参考资料
${contextText}

## 问题
${question}

## 要求
- 基于资料回答，不编造。参考资料情况不同，开头说明必须如实、不得误导：
  - 参考资料与问题无关（检索到但用不上）→ 第一句说明"知识库未检索到与问题相关的内容"
  - 参考资料相关但覆盖不足（如缺少问题的某一方面）→ 第一句如实说明"知识库中关于【缺失方面】的内容有限"，并标注该部分基于临床常识、仅供参考；**不得说"知识库未收录该内容"**
  - 资料足以回答 → 直接回答，无需以上说明
${typeRule}
- 分点条理清晰；【每个要点/每条分点必须标注 [参考N]】；禁止出现没有引用标注的要点，宁可多标不可漏标
- 引用编号必须真实对应参考资料【参考N】的内容，引用不存在的编号属于错误
- 尽量覆盖参考资料中与问题直接相关的全部要点，不要遗漏（完整性优先，但不要写与问题无关的内容）
- 结尾加一句临床提示（如果有）
- 语言简洁，不要重复问题，不要寒暄
- 回答控制在 500 字以内
${extraHint}`
}

/**
 * 统一的 LLM 调用（DeepSeek Chat Completions）
 * @param {Object[]} messages
 * @param {string} model
 * @param {Object} [opts]
 * @returns {Promise<string>} 回答文本
 */
const callLLM = async (messages, model, opts = {}) => {
    const { temperature = 0.3, maxTokens = 2000, timeoutMs = 60000 } = opts
    const llm = await settings.getLLM() // 界面化配置优先，env 兜底
    const apiUrl = opts.apiUrl || llm.apiUrl // 支持自定义端点（如本地模型 ollama）
    const apiKey = opts.apiKey !== undefined ? opts.apiKey : llm.apiKey
    const req = superagent
        .post(apiUrl)
        .send({ model, messages, temperature, max_tokens: maxTokens })
        .set('Content-Type', 'application/json')
        .timeout({ response: timeoutMs })
    if (apiKey) req.set('Authorization', `Bearer ${apiKey}`)
    const res = await req
    const text = res.body?.choices?.[0]?.message?.content || ''
    // returnUsage：对比实验等场景需要展示 token 消耗（老板看板），返回 { text, usage }
    if (opts.returnUsage) return { text, usage: res.body?.usage || null }
    return text
}

/**
 * 调用 LLM 生成回答（v2）
 * @param {string} question - 医生提问
 * @param {Object[]} sources - 检索到的知识段落
 * @param {Array} [history] - 多轮对话历史
 * @param {Object} [options]
 * @param {string} [options.model] - 指定模型（多模型路由），默认快模型
 * @param {string} [options.extraHint] - 附加指令（如重试修正提示）
 * @returns {Promise<{answer: string, model: string, promptVersion: string}|null>}
 */
const generateAnswer = async (question, sources, history = [], options = {}) => {
    if (!sources || sources.length === 0) {
        return {
            answer: '抱歉，未能在知识库中找到与您问题相关的内容。建议您换个表述方式提问，或联系科室主任获取指导。',
            model: 'none',
            promptVersion: PROMPT_VERSION,
        }
    }

    const fastModel = (await settings.getLLM()).model
    const model = options.model || fastModel
    // 自定义端点支持（对比实验 localrag：本地模型 + 知识库检索）
    const callOpts = { temperature: 0.3, maxTokens: 2000 }
    if (options.apiUrl) callOpts.apiUrl = options.apiUrl
    if (options.apiKey !== undefined) callOpts.apiKey = options.apiKey
    if (options.timeoutMs) callOpts.timeoutMs = options.timeoutMs // 本地模型生成慢，需放宽超时
    if (options.returnUsage) callOpts.returnUsage = true // 对比实验：返回 token 消耗供前端展示
    const prompt = buildPrompt(question, sources, options.extraHint || '')

    // 组装 messages：system（带 few-shot 示例）+ 历史对话 + 当前问题
    const messages = [
        {
            role: 'system',
            content: '你是一位专业的医学知识问答助手，服务于临床医生。回答要基于提供的参考资料，多轮对话时注意结合上下文。\n\n回答格式示例（供参考，仅示例格式）：\n问题：高血压的诊断标准是什么？\n回答：非同日3次测量诊室血压，收缩压≥140mmHg和/或舒张压≥90mmHg，可诊断高血压。[参考1] 按血压水平分为：1级（140-159/90-99mmHg）、2级（160-179/100-109mmHg）、3级（≥180/110mmHg）。[参考2]',
        },
    ]

    // 历史对话（压缩：控制 token 预算，避免挤占当前回答空间）
    const compacted = compactHistory(history)
    for (const h of compacted) {
        if (h.role === 'user' || h.role === 'assistant') {
            messages.push({ role: h.role, content: h.content })
        }
    }

    // 当前问题（带参考资料）
    messages.push({ role: 'user', content: prompt })

    try {
        log(`[generateAnswer] 调用 LLM: model=${model}, history=${history.length}条, promptVersion=${PROMPT_VERSION}`)
        // callLLM 支持 returnUsage（返回 {text, usage}）；兼容旧返回（纯文本）
        const raw = await callLLM(messages, model, callOpts)
        const answer = typeof raw === 'object' ? raw.text : raw
        const usage = typeof raw === 'object' ? raw.usage : null
        if (!answer) {
            // API 偶发空响应（限流等）：重试一次
            log('[generateAnswer] LLM 返回为空，重试一次')
            const retryRaw = await callLLM(messages, model, callOpts)
            const retry = typeof retryRaw === 'object' ? retryRaw.text : retryRaw
            const retryUsage = typeof retryRaw === 'object' ? retryRaw.usage : null
            if (!retry) {
                log('[generateAnswer] 重试仍为空')
                return null
            }
            log(`[generateAnswer] 重试成功, 长度=${retry.length}`)
            return { answer: retry, model, promptVersion: PROMPT_VERSION, usage: retryUsage }
        }
        log(`[generateAnswer] 回答生成成功, 长度=${answer.length}`)
        return { answer, model, promptVersion: PROMPT_VERSION, usage }
    } catch (error) {
        log(`[generateAnswer] model=${model} 调用失败: ${error.message}`)
        if (error.response) {
            log(`[generateAnswer] 状态码: ${error.response.status}, body: ${JSON.stringify(error.response.body).slice(0, 200)}`)
        }
        // 强模型失败自动降级到快模型重试一次（生产容错）；对比实验（noFallback）禁止降级，保证实验变量纯净
        if (!options.noFallback && model !== fastModel) {
            log(`[generateAnswer] 降级到快模型 ${fastModel} 重试`)
            try {
                const raw = await callLLM(messages, fastModel, callOpts)
                const answer = typeof raw === 'object' ? raw.text : raw
                const usage = typeof raw === 'object' ? raw.usage : null
                if (!answer) return null
                return { answer, model: fastModel, promptVersion: PROMPT_VERSION, usage }
            } catch (e2) {
                log(`[generateAnswer] 降级重试也失败: ${e2.message}`)
                return null
            }
        }
        return null
    }
}

/**
 * 长/宽泛问题提炼为精炼搜索词
 * 用 LLM 把啰嗦的提问压缩成关键的医学检索语
 * 例："我最近血压有点高，想知道高血压的诊断标准是什么" → "高血压诊断标准"
 * @param {string} question - 原始提问
 * @returns {Promise<string>} 提炼后的搜索词（失败则返回原文）
 */
const refineQuery = async (question) => {
    const prompt = `你是一个医学搜索助手。请把下面的问题提炼成3~8个字的精炼搜索词，
只保留最核心的医学关键词，去掉寒暄、描述性语句和废话。

## 原始提问
${question}

## 要求
- 直接输出提炼后的搜索词，不要任何解释
- 控制在3~8个字
- 必须是中文医学关键词
- 如果问题已经很简洁（<15字），直接原样输出`

    try {
        const { model } = await settings.getLLM() // 关键词提炼始终用快模型（便宜、延迟低）
        const answer = await callLLM(
            [
                { role: 'system', content: '你是一个医学搜索关键词提取助手，只输出关键词不输出其他内容。' },
                { role: 'user', content: prompt },
            ],
            model,
            { temperature: 0.1, maxTokens: 50, timeoutMs: 15000 }
        )
        const text = (answer || '').trim()
        log(`[refineQuery] LLM返回: "${text}"`)
        if (text && text.length >= 3 && text.length <= 30) {
            log(`[refineQuery] "${question.slice(0, 20)}..." → "${text}"`)
            return text
        }
        log('[refineQuery] 返回不符合条件，使用原文')
        return question
    } catch (error) {
        log(`[refineQuery] LLM提炼失败，使用原文: ${error.message}`)
        return question
    }
}

/**
 * 知识库未命中时的兜底回答
 * 用 LLM 通用医学知识回答，但明确标注非知识库内容、仅供参考
 * @param {string} question - 医生提问
 * @param {Array} [history] - 多轮对话历史
 * @param {string} [model] - 指定模型（可选；默认快模型，调用方可按分级路由传入强模型）
 * @returns {Promise<{answer: string, model: string}|null>} 失败返回 null
 */
const generateFallbackAnswer = async (question, history = [], model = null) => {
    const prompt = `医生提问的内容在本平台知识库中未找到对应资料，以下回答基于 AI 通用医学知识。

## 问题
${question}

## 要求
- 第一句明确说明：“⚠️ 该问题未收录在当前知识库中，以下回答来自 AI 通用知识，仅供参考，请以权威指南和临床实际为准”
- 基于共识医学知识分点回答，条理清晰（可用序号/要点）
- 不确定或记忆模糊的地方（尤其是具体数值、剂量、分期标准）如实标注“（不确定）”，不要编造
- 最后给出 1-2 条进一步建议（如建议咨询的专科、推荐的检查方向、可参考的权威指南）
- 控制在 400 字以内`
    try {
        const { model: cfgModel } = await settings.getLLM()
        const useModel = model || cfgModel // 兑底也可分级路由（复杂问题用强模型）
        const messages = [
            { role: 'system', content: '你是一位谨慎的医学知识助手。知识库未收录的问题也要尽量帮助医生，但必须如实标注信息来源和不确定性。' },
        ]
        const compacted = compactHistory(history)
        for (const h of compacted) {
            if (h.role === 'user' || h.role === 'assistant') messages.push({ role: h.role, content: h.content })
        }
        messages.push({ role: 'user', content: prompt })

        const answer = await callLLM(messages, useModel, { temperature: 0.3, maxTokens: 1500 })
        if (!answer) return null
        log(`[fallback] 兑底回答生成成功, model=${useModel}, 长度=${answer.length}`)
        return { answer, model: useModel }
    } catch (error) {
        log(`[fallback] 兜底回答失败: ${error.message}`)
        return null
    }
}

/**
 * 无 RAG 直接回答（对比实验用：不检索知识库，纯 LLM 通用知识）
 * 不带 [参考N] 引用、不带“未收录”声明——干净对照 prompt，B/D 组共用（模型可指定）
 * @param {string} question - 医生提问
 * @param {Array} [history] - 多轮对话历史
 * @param {string} [model] - 指定模型（默认走 settings 快模型）；本地模型对照时传入本地模型名
 * @returns {Promise<{answer: string, model: string}|null>} 失败返回 null
 */
// 诚实约束提示（防幻觉）：知识外/截止后必须明说不确定，绝不编造数值/版本/政策
const HONEST_HINT = '\n- 重要：如果问题涉及你知识截止日期之后的信息（新版指南/新获批药物/新政策），必须明确回答“我的知识中没有该信息/我不确定”，绝不编造具体数值、版本或政策变化；宁可说不知道，也不能给出可能错误的答案'

const generateDirectAnswer = async (question, history = [], model = null, provider = null, opts = {}) => {
    const { detailed = false, honest = false } = opts || {}
    // 对比实验 local 组（本地微调模型）：详细模式，避免被“400 字以内”压成要点式回答
    // honest（本地兜底/诚实模式）：强约束防幻觉——知识外/截止后必须明说不确定，绝不编造数值/版本/政策
    const prompt = detailed
        ? `请用你的医学知识回答以下问题。

## 问题
${question}

## 要求
- 基于共识医学知识回答，内容尽量完整、详细，每个要点适当展开解释（如诊断阈值、测量要求、分级/分期标准）
- 不确定或记忆模糊的地方如实说明，不要编造（尤其是具体数值、剂量、分期标准）
- 分点条理清晰，控制在 400~800 字
- 不要使用 [参考N] 之类的引用标注（你无法访问资料库）${honest ? HONEST_HINT : ''}`
        : `请用你的医学知识回答以下问题。

## 问题
${question}

## 要求
- 基于共识医学知识回答，内容尽量完整、准确
- 不确定或记忆模糊的地方如实说明，不要编造（尤其是具体数值、剂量、分期标准）
- 分点条理清晰，控制在 400 字以内
- 不要使用 [参考N] 之类的引用标注（你无法访问资料库）${honest ? HONEST_HINT : ''}`
    try {
        const { model: cfgModel } = await settings.getLLM()
        const useModel = model || cfgModel
        const messages = [
            { role: 'system', content: '你是一位专业的医学知识助手。根据自身的医学知识回答临床医生的问题，诚实标注不确定性，不编造。' },
        ]
        const compacted = compactHistory(history)
        for (const h of compacted) {
            if (h.role === 'user' || h.role === 'assistant') messages.push({ role: h.role, content: h.content })
        }
        messages.push({ role: 'user', content: prompt })

        // provider：自定义端点（本地模型用 { apiUrl, apiKey }），默认走平台 LLM 配置
        const callOpts = { temperature: 0.3, maxTokens: 2000 }
        if (provider && provider.apiUrl) {
            callOpts.apiUrl = provider.apiUrl
            callOpts.apiKey = provider.apiKey
        }
        if (opts.returnUsage) callOpts.returnUsage = true // 对比实验：返回 token 消耗供前端展示
        // 失败重试：DeepSeek API 偶发空响应/瞬时错误（4~20s 内快速失败，非超时），重试 2 次显著降 502
        let answer = ''
        let usage = null
        for (let attempt = 1; attempt <= 2 && !answer; attempt++) {
            if (attempt > 1) await new Promise(res => setTimeout(res, 800))
            try {
                const raw = await callLLM(messages, useModel, callOpts)
                if (typeof raw === 'object') { answer = raw.text; usage = raw.usage } else { answer = raw }
            } catch (e) {
                log(`[directAnswer] 第${attempt}次调用异常: ${e.message}`)
                answer = ''
            }
        }
        if (!answer) return null
        log(`[directAnswer] 无RAG回答生成成功, model=${useModel}, 长度=${answer.length}`)
        return { answer, model: useModel, usage }
    } catch (error) {
        log(`[directAnswer] 无RAG回答失败: ${error.message}`)
        return null
    }
}

/**
 * 基于联网搜索结果生成回答（未收录问题时使用，带来源标注 + 免责）
 * @param {string} question - 医生提问
 * @param {Array<{title,link,snippet,sim}>} webResults - 已通过相关度把关的搜索结果
 * @returns {Promise<{answer: string, model: string}|null>} 失败返回 null
 */
const generateWebAnswer = async (question, webResults, modelOverride = null) => {
    const sources = webResults.map((r, i) => `[${i + 1}]${r.authoritative ? '【权威来源】' : ''} ${r.title} ${r.link}\n${r.snippet}`).join('\n\n')
    const prompt = `医生提问的内容在本平台知识库中未找到对应资料，以下是通过网络搜索获得的实时资料。
请**仅基于**这些资料回答，不得添加资料中不存在的信息：

## 问题
${question}

## 网络搜索结果
${sources}

## 要求
- 第一句明确说明："⚠️ 该回答来自网络搜索，未经知识库审核，仅供参考，请以权威指南和临床实际为准"
- 优先采用标有【权威来源】的资料（政府机构/顶级医院/医学专业平台/学术文献），来源权威性低的内容谨慎使用
- 逐条回答，每个要点末尾标注来源编号，如（来源1）（来源2）
- 资料中没有的内容，明确说"搜索结果中未提及"，禁止推测编造
- 资料相互矛盾时，指出矛盾并建议以权威指南为准
- 分点条理清晰，控制在 400 字以内
- 回答末尾列出所有来源链接`

    const { model: defaultModel } = await settings.getLLM()
    const model = modelOverride || defaultModel // 对比实验 mode=strong 时强制强模型
    try {
        const answer = await callLLM(
            [
                { role: 'system', content: '你是一位谨慎的医学知识助手。网络资料仅供当前问题参考，务必只基于给定资料回答，杜绝编造。' },
                { role: 'user', content: prompt },
            ],
            model,
            { temperature: 0.2, maxTokens: 1500 }
        )
        if (!answer || answer.trim().length < 20) return null
        log(`[webAnswer] 联网回答生成成功, 长度=${answer.length}`)
        return { answer, model }
    } catch (error) {
        log(`[webAnswer] 联网回答失败: ${error.message}`)
        return null
    }
}

/**
 * 流式调用 LLM（SSE 增量返回）
 * @param {Object[]} messages
 * @param {string} model
 * @param {Function} onDelta - (delta, fullText) => void
 * @param {Object} [opts]
 * @returns {Promise<string>} 完整回答文本
 */
const callLLMStream = async (messages, model, onDelta, opts = {}) => {
    const { temperature = 0.3, maxTokens = 2000, timeoutMs = 90000 } = opts
    // 自定义端点支持（提问前选本地模型：Ollama http 端点）；未指定走平台 LLM 配置
    const llmCfg = opts.apiUrl ? opts : await settings.getLLM()
    const apiUrl = opts.apiUrl || llmCfg.apiUrl
    const apiKey = opts.apiKey !== undefined ? opts.apiKey : llmCfg.apiKey
    const url = new URL(apiUrl)
    const transport = url.protocol === 'http:' ? http : https
    const payload = JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: true })

    return new Promise((resolve, reject) => {
        const req = transport.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        timeout: timeoutMs,
    }, (res) => {
        if (res.statusCode !== 200) {
            let errBody = ''
            res.on('data', c => errBody += c)
            res.on('end', () => reject(new Error(`LLM HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)))
            return
        }

        let buffer = ''
        let fullText = ''
        res.on('data', (chunk) => {
            buffer += chunk.toString('utf8')
            let idx
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx).trim()
                buffer = buffer.slice(idx + 1)
                if (!line.startsWith('data:')) continue
                const data = line.slice(5).trim()
                if (!data || data === '[DONE]') continue
                try {
                    const parsed = JSON.parse(data)
                    const delta = parsed.choices?.[0]?.delta?.content || ''
                    if (delta) {
                        fullText += delta
                        if (onDelta) onDelta(delta, fullText)
                    }
                } catch { /* 忽略无法解析的帧 */ }
            }
        })
        res.on('end', () => resolve(fullText))
        res.on('error', reject)
    })
        req.on('timeout', () => req.destroy(new Error('LLM 流式请求超时')))
        req.on('error', reject)
        req.write(payload)
        req.end()
    })
}

/**
 * 生成回答（流式版）：组装 messages 后调用流式接口
 * @param {string} question
 * @param {Object[]} sources
 * @param {Array} [history]
 * @param {Object} [options] - { model, extraHint }
 * @param {Function} onDelta - (delta, fullText) => void
 * @returns {Promise<{answer, model, promptVersion}|null>}
 */
const streamAnswer = async (question, sources, history = [], options = {}, onDelta) => {
    if (!sources || sources.length === 0) return null

    const fastModel = (await settings.getLLM()).model
    const model = options.model || fastModel
    // 自定义端点（提问前选本地模型）：透传 apiUrl/apiKey/timeoutMs 给流式调用
    const streamOpts = { temperature: 0.3, maxTokens: 4000 }
    if (options.apiUrl) streamOpts.apiUrl = options.apiUrl
    if (options.apiKey !== undefined) streamOpts.apiKey = options.apiKey
    if (options.timeoutMs) streamOpts.timeoutMs = options.timeoutMs
    const prompt = buildPrompt(question, sources, options.extraHint || '')

    const messages = [
        {
            role: 'system',
            content: '你是一位专业的医学知识问答助手，服务于临床医生。回答要基于提供的参考资料，多轮对话时注意结合上下文。\n\n回答格式示例（供参考，仅示例格式）：\n问题：高血压的诊断标准是什么？\n回答：非同日3次测量诊室血压，收缩压≥140mmHg和/或舒张压≥90mmHg，可诊断高血压。[参考1] 按血压水平分为：1级（140-159/90-99mmHg）、2级（160-179/100-109mmHg）、3级（≥180/110mmHg）。[参考2]',
        },
    ]
    const compacted = compactHistory(history)
    for (const h of compacted) {
        if (h.role === 'user' || h.role === 'assistant') messages.push({ role: h.role, content: h.content })
    }
    messages.push({ role: 'user', content: prompt })

    try {
        log(`[streamAnswer] 流式调用 LLM: model=${model}, history=${history.length}条, promptVersion=${PROMPT_VERSION}`)
        // maxTokens 4000：reasoning 模型（flash/pro）会先输出长推理过程，2000 偶发把 content 截断成空（finish=length）
        const answer = await callLLMStream(messages, model, onDelta, streamOpts)
        if (!answer) {
            // API 偶发空响应（限流/截断等）：重试一次；空响应时无 delta 帧，重试不会产生重复内容
            log('[streamAnswer] LLM 返回为空，重试一次')
            const retry = await callLLMStream(messages, model, onDelta, streamOpts)
            if (!retry) {
                log('[streamAnswer] 重试仍为空')
                return null
            }
            log(`[streamAnswer] 重试成功, 长度=${retry.length}`)
            return { answer: retry, model, promptVersion: PROMPT_VERSION }
        }
        log(`[streamAnswer] 流式完成, 长度=${answer.length}`)
        return { answer, model, promptVersion: PROMPT_VERSION }
    } catch (error) {
        log(`[streamAnswer] model=${model} 调用失败: ${error.message}`)
        // 强模型失败自动降级到快模型重试一次
        if (model !== fastModel) {
            log(`[streamAnswer] 降级到快模型 ${fastModel} 重试`)
            try {
                const answer = await callLLMStream(messages, fastModel, onDelta, { temperature: 0.3, maxTokens: 4000 })
                if (!answer) return null
                return { answer, model: fastModel, promptVersion: PROMPT_VERSION }
            } catch (e2) {
                log(`[streamAnswer] 降级重试也失败: ${e2.message}`)
                return null
            }
        }
        return null
    }
}

module.exports = { generateAnswer, buildPrompt, classifyQuestion, refineQuery, generateFallbackAnswer, generateDirectAnswer, generateWebAnswer, compactHistory, streamAnswer, callLLM, callLLMStream, PROMPT_VERSION }
