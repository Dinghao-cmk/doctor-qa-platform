/**
 * tokenizer.js - 中文分词服务（jieba，Rust 实现，极快）
 * 用途：段落入库时对内容分词存 text[]，查询时对问题分词匹配
 * 配合 rag_passage.content_terms 列 + GIN 数组索引，替代 pg_trgm 对 2 字中文词的弱支持
 */
const { Jieba } = require('@node-rs/jieba')
const { dict } = require('@node-rs/jieba/dict')

let jieba = null
const getJieba = () => {
    if (!jieba) {
        jieba = new Jieba()
        jieba.loadDict(dict)
    }
    return jieba
}

// 停用词：虚词 + 疑问词 + 医学高频泛词（治疗/患者/方案等），两侧统一过滤，
// 避免泛词凑分导致噪音段落命中（如"治疗+方案"拼出 2 分）
const STOP_WORDS = new Set([
    '的', '了', '是', '在', '和', '与', '或', '及', '等', '应', '需', '为',
    '有', '不', '未', '对', '中', '上', '下', '该', '此', '其', '之',
    '个', '也', '都', '而', '被', '从', '到', '并', '且', '但', '可',
    '要', '后', '前', '时', '内', '外', '间', '按', '于', '若', '则',
    '如果', '因为', '所以', '但是', '然而',
    '怎么', '如何', '什么', '哪些', '多少', '可以', '能否', '是否',
    // 医学/通用高频泛词（区分度低，禁用后查询更聚焦特异词）
    '治疗', '方案', '使用', '进行', '出现', '发生', '给予', '预防',
    '需要', '患者', '病人', '药物', '情况', '问题', '建议', '注意',
    '主要', '常见', '一般', '包括', '以及', '或者', '相关', '可能',
    '根据', '建议', '采用', '方法', '临床', '研究', '结果', '表明',
])

/**
 * 中文分词，返回去重后的关键词数组（>=2 字，去停用词）
 * @param {string} text
 * @returns {string[]}
 */
const segment = (text) => {
    if (!text) return []
    const words = getJieba().cut(text, false)
    const seen = new Set()
    const result = []
    for (const w of words) {
        const t = (w || '').trim()
        if (t.length < 2) continue
        if (STOP_WORDS.has(t)) continue
        // 纯数字/英文/符号组合（无中文）不参与中文检索
        if (!/[\u4e00-\u9fa5]/.test(t)) continue
        if (seen.has(t)) continue
        seen.add(t)
        result.push(t)
    }
    return result
}

module.exports = { segment }
