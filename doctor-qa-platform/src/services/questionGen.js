/**
 * questionGen.js - 医学问题集生成服务（新书专项题库）
 *
 * 从书籍章节标题自动生成医学标准问题（规则模板，零 LLM 成本）：
 * - 仅用 level2 章节（具体疾病/症状/检查）
 * - 标题清洗：去"第X章"前缀、ICD 编码前缀
 * - 按标题类型生成 1~2 问：诊断标准/治疗原则/要点
 *
 * 供两处使用：
 * 1. scripts/eval/generate_questions.js（全库题库）
 * 2. routes/upload.js 入库成功后（新书专项题库，追加到 questions.json）
 */
const SKIP_BOOKS = ['质控知识库']

const SKIP_WORDS = [
    '概述', '前言', '附录', '目录', '总论', '总则', '参考文献', '索引', '后记',
    '序言', '致谢', '编写说明', '使用说明', '编写人员', '出版说明', '缩略语',
    '目 录', '说明', '序', '跋', '编委会', '名词术语',
]

const SKIP_PATTERNS = [
    /系统/,
    /[科]$/,
    /学$/,
    /类质控/,
]

const cleanTitle = (title) => {
    let t = (title || '').trim()
    t = t.replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分]+\s*/, '')
    t = t.replace(/^[A-Za-z]\d+(\.\d+)?\s*/, '')
    t = t.replace(/^\d+[\.、）)]\s*/, '')
    t = t.replace(/^[（(][^（()）]*[)）]\s*/, '')
    t = t.replace(/[《》"“”]/g, '')
    return t.trim()
}

const isMeaningful = (title) => {
    if (title.length < 2 || title.length > 12) return false
    if (SKIP_WORDS.some(w => title.includes(w))) return false
    if (SKIP_PATTERNS.some(p => p.test(title))) return false
    if (/^[，。、；：！？,.!?;\s]+$/.test(title)) return false
    return true
}

const genQuestions = (title) => {
    const qs = []
    if (/(检查|检验|CT|X线|B超|超声|解读)/.test(title)) {
        qs.push({ category: 'diagnosis', question: `${title}的临床意义是什么？` })
        return qs
    }
    if (/(诊断标准|标准|选择|方案|用药|治疗|分级|分类|原则)/.test(title)) {
        qs.push({ category: /诊断|标准|分级|分类/.test(title) ? 'diagnosis' : 'treatment', question: `${title}有哪些要点？` })
        return qs
    }
    qs.push({ category: 'diagnosis', question: `${title}的诊断标准是什么？` })
    qs.push({ category: 'treatment', question: `${title}的治疗原则是什么？` })
    return qs
}

/**
 * 从书籍文档树生成专项问题集
 * @param {Object} book - { id, title }
 * @param {Object[]} docs - 该书整棵树的文档（含 id/title/level/parent_id）
 * @returns {Array} 问题列表 [{ bookId, bookTitle, chapter, category, question }]
 */
const genBookQuestions = (book, docs) => {
    if (SKIP_BOOKS.includes(book.title)) return []
    const questions = []
    const level2s = docs.filter(d => d.level === 2)
    for (const d of level2s) {
        const title = cleanTitle(d.title)
        if (!isMeaningful(title)) continue
        for (const q of genQuestions(title)) {
            questions.push({ bookId: book.id, bookTitle: book.title, chapter: title, category: q.category, question: q.question })
        }
    }
    return questions
}

module.exports = { genBookQuestions, genQuestions, cleanTitle, isMeaningful }
