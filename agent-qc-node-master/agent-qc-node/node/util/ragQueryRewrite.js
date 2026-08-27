// ------------------------------------------------------------------------------
// 文件名称: ragQueryRewrite.js
// 主要功能: RAG 检索词重写（LLM）+ 失败稳健回退
// 设计要点:
//   - 使用 askLLM.autoRetryAskLLM，temperature=0，2秒超时，1次重试
//   - 仅输出一条短语（不超过40字），更贴近专业长句表述，便于向量命中
//   - 任意异常或空输出时，优雅降级为 originalQuery
// ------------------------------------------------------------------------------

const debug = require('debug')
const askLLM = require('../config/askLLM')
const { enableRewriteByRuleCode, enableRewriteDefault } = require('../config/ragOptimization')

const log = debug('qc:rag-rewrite')

/**
 * 判断指定规则是否开启了检索词重写
 * @param {string} ruleCode - 规则编码
 * @returns {boolean} 是否开启
 */
const isRewriteEnabledForRule = (ruleCode) => {
    if (!ruleCode) return !!enableRewriteDefault
    if (Object.prototype.hasOwnProperty.call(enableRewriteByRuleCode, ruleCode)) {
        return !!enableRewriteByRuleCode[ruleCode]
    }
    return !!enableRewriteDefault
}

/**
 * 裁剪规则文本，避免 prompt 过长（最多保留前 800 字符）
 * @param {string} ruleYaml - 规则文本
 * @returns {string} 裁剪后的文本
 */
const clipRuleText = (ruleYaml) => {
    if (!ruleYaml) return ''
    const s = String(ruleYaml)
    return s.length > 800 ? s.slice(0, 800) : s
}

/**
 * 生成重写提示词
 * @param {string} originalQuery - 原始检索词
 * @param {string} ruleCode - 规则编码
 * @param {string} ruleYaml - 规则文本
 * @returns {string} 完整 Prompt
 */
const buildRewritePrompt = (originalQuery, ruleCode, ruleYaml) => {
    const clipped = clipRuleText(ruleYaml)
    return `
你是医疗质控知识检索的“查询词重写器”。

任务: 将下述缺陷描述重写为更专业、贴近规则长句表述的中文短语，以提升在同一质控规则下的知识库召回率。

要求:
- 用专业术语完整表达核心语义，保留关键要点与常见同义说法；
- 控制在 10~40 个汉字内，避免标点与冗余修饰；
- 仅输出重写后的短语，不要任何解释或前后缀。

上下文（仅供理解，不要复述原文）:
- 规则编码: ${ruleCode || ''}
- 规则要点: ${clipped}

原始缺陷描述: ${originalQuery}
`
}

/**
 * getRewrittenQuery: LLM 重写检索词（2秒超时+1次重试），失败回退原词
 * @param {Object} params - 参数对象
 * @param {string} params.originalQuery - 原始缺陷描述/检索词
 * @param {string} [params.ruleCode] - 质控规则编码
 * @param {string} [params.ruleYaml] - 规则文本（已去除元字段）
 * @param {Object} [params.emrtxtRecord] - 病历记录，用于日志打点（可选）
 * @returns {Promise<string>} 可用的查询字符串（永不为空；失败回退为 originalQuery）
 */
const getRewrittenQuery = async ({ originalQuery, ruleCode, ruleYaml, emrtxtRecord }) => {
    const trimmed = String(originalQuery || '').trim()
    if (!trimmed) return ''

    // 未开启重写则直接返回原词
    if (!isRewriteEnabledForRule(ruleCode)) {
        return trimmed
    }

    try {
        const prompt = buildRewritePrompt(trimmed, ruleCode, ruleYaml)

        const rewritten = await askLLM.autoRetryAskLLM(prompt, 'star-fast', {
            expectFormat: 'txt',
            maxRetries: 1,                // 1 次重试（共 2 次）
            enableEncrypt: false,
            timeoutResponseMs: 2000,      // 首包超时 2s
            timeoutDeadlineMs: 2000,      // 总耗时上限 2s
            // 日志打点字段（若缺失不写库，不影响主流程）
            emrtxt_id: emrtxtRecord?.id,
            emr_name: emrtxtRecord?.mr_name,
            emr_type: emrtxtRecord?.mr_type,
            visit_id: emrtxtRecord?.visit_id,
            rule_code: ruleCode,
            invoke_type: 'rag_query_rewrite',
            invoke_model: 'star-fast',
            // 基础格式校验：非空字符串
            validateResponse: (txt) => {
                const s = (txt || '').toString().trim()
                if (!s) return { valid: false, formatError: '空字符串' }
                // 追加长度与字符集约束（仅汉字与常见标点/空格），防止输出段落
                if (s.length < 4 || s.length > 60) return { valid: false, formatError: '长度不在 4~60 之间' }
                return { valid: true }
            },
        })

        const normalized = String(rewritten || '').replace(/[\n\r]+/g, ' ').trim()
        // 过滤常见引号/代码块包裹
        const unquoted = normalized.replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '').trim()

        // 非空则采用重写，否则回退
        return unquoted || trimmed
    } catch (e) {
        log(`重写失败，使用原词回退: ${e?.message || e}`)
        return trimmed
    }
}

module.exports = {
    getRewrittenQuery,
    isRewriteEnabledForRule,
}
