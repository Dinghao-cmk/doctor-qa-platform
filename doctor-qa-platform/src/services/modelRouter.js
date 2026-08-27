/**
 * modelRouter.js - 多模型分级路由
 *
 * 架构决策（老板确认）：中间环节（rerank/领域分类/搜索词提炼）用快模型；问答统一用强模型
 * - 强模型（config.llm.strongModel）：所有问答生成（回答质量优先）
 * - 快模型（config.llm.model）：rerank/分类/关键词提炼等中间环节（延迟低、成本低）
 *
 * 兼容模式：LLM_QA_DEFAULT_STRONG=false 时启用旧的按复杂度路由
 * （问题长度 ≥40 字 / 多源综合 / 追问 ≥3 轮 / 复杂问法关键词 → 强模型，否则快模型）
 */
const config = require('../config')
const settings = require('./settings')

// 触发强模型的复杂问法关键词（兼容模式用）
const COMPLEX_PATTERNS = [
    /鉴别/, /机制/, /为什么/, /对比/, /区别/, /差异/, /预后/, /并发症/,
    /个体化/, /如何选择/, /怎么选/, /评估/, /风险/, /关系/, /相互作用/,
    /综合考虑/, /权衡/, /进展/, /转归/,
]

// 多源综合类词：需要跨书整合知识的问题类型（兼容模式用）
const SYNTHESIS_PATTERNS = [
    /治疗/, /方案/, /用药/, /管理/, /处理/, /鉴别/, /原则/, /综合/,
]

/**
 * 路由决策：返回选定的模型名（问答生成）
 * @param {Object} ctx - 路由上下文
 * @param {string} ctx.question - 当前问题
 * @param {number} ctx.bookCount - 检索命中的书籍数
 * @param {number} ctx.round - 当前对话轮数
 * @returns {string} 模型名
 */
const pickModel = async ({ question = '', bookCount = 1, round = 1 } = {}) => {
    // 界面化配置优先（settings 表），env 兜底
    const { model, strongModel } = await settings.getLLM()
    // 问答默认统一用强模型（回答质量优先；LLM_QA_DEFAULT_STRONG=false 可切回按复杂度路由）
    const defaultStrong = (process.env.LLM_QA_DEFAULT_STRONG || 'true') !== 'false'
    if (defaultStrong) return strongModel
    // 兼容模式：按复杂度路由
    if (question.length >= 40) return strongModel
    if (bookCount >= 4 && SYNTHESIS_PATTERNS.some(p => p.test(question))) return strongModel
    if (round >= 3) return strongModel
    if (COMPLEX_PATTERNS.some(p => p.test(question))) return strongModel
    return model
}

module.exports = { pickModel }
