/**
 * modelRouter.js - 多模型分级路由
 *
 * 规则路由（零 LLM 判断成本）：根据问题复杂度、命中书数、追问轮数选择快/强模型
 * - 快模型（config.llm.model）：日常简单问题，响应快、成本低
 * - 强模型（config.llm.strongModel）：复杂问题，推理能力更强
 *
 * 触发强模型的规则（命中任一）：
 * 1. 问题长度 ≥ 40 字（描述复杂，需要长文本理解）
 * 2. 多源综合：命中 ≥3 本书 且 问题含综合类词（治疗/方案/用药/管理/处理/鉴别/原则）
 *    —— 注意：本知识库搜索按书分组取 top，单书问题也会命中多本，
 *       故书数规则必须与"需要综合"的问题类型绑定，否则会全部误触发
 * 3. 追问轮数 ≥ 3（长对话上下文复杂）
 * 4. 含复杂问法关键词（鉴别/机制/为什么/对比/预后等）
 */
const config = require('../config')
const settings = require('./settings')

// 触发强模型的复杂问法关键词
const COMPLEX_PATTERNS = [
    /鉴别/, /机制/, /为什么/, /对比/, /区别/, /差异/, /预后/, /并发症/,
    /个体化/, /如何选择/, /怎么选/, /评估/, /风险/, /关系/, /相互作用/,
    /综合考虑/, /权衡/, /进展/, /转归/,
]

// 多源综合类词：需要跨书整合知识的问题类型
const SYNTHESIS_PATTERNS = [
    /治疗/, /方案/, /用药/, /管理/, /处理/, /鉴别/, /原则/, /综合/,
]

/**
 * 路由决策：返回选定的模型名
 * @param {Object} ctx - 路由上下文
 * @param {string} ctx.question - 当前问题
 * @param {number} ctx.bookCount - 检索命中的书籍数
 * @param {number} ctx.round - 当前对话轮数
 * @returns {string} 模型名
 */
const pickModel = async ({ question = '', bookCount = 1, round = 1 } = {}) => {
    // 界面化配置优先（settings 表），env 兜底
    const { model, strongModel } = await settings.getLLM()
    // 规则 1：问题长度 ≥40 字（描述复杂）
    if (question.length >= 40) return strongModel
    // 规则 2：多源综合（命中 ≥4 本 且 问题需要跨书综合）
    // —— 本知识库搜索按书分组取 top，单书问题也会命中多本；门槛 4 本避免常见问题（如“XX治疗原则”命中 3 本）误上强模型拖慢响应
    if (bookCount >= 4 && SYNTHESIS_PATTERNS.some(p => p.test(question))) return strongModel
    // 规则 3：追问轮数 ≥3（长对话上下文复杂）
    if (round >= 3) return strongModel
    // 规则 4：含复杂问法关键词
    if (COMPLEX_PATTERNS.some(p => p.test(question))) return strongModel
    return model
}

module.exports = { pickModel }
