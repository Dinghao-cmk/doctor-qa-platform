/**
 * scripts/eval/generate_questions.js - 黄金题库生成器
 *
 * 从知识库章节标题自动生成医学标准问题集（规则模板，零 LLM 成本）：
 * - 仅用 level2 章节（具体疾病/症状/检查，如 J18 肺炎、发热、血常规检查）
 * - 标题清洗：去"第X章"前缀、ICD 编码前缀（J18 肺炎 → 肺炎）
 * - 排除非医学书籍（质控知识库）和宽泛标题
 * - 按标题类型生成 1~2 问：诊断标准/治疗原则/要点
 * - 每本书最多 6 题，总题库目标 40~60 题
 *
 * 用法：node scripts/eval/generate_questions.js
 * 输出：scripts/eval/questions.json（可人工追加/修改，评测脚本直接读取）
 */
const fs = require('fs')
const path = require('path')
const { db } = require('../../src/db')

const OUT_FILE = path.join(__dirname, 'questions.json')

// 不生成问题的书籍（非医学内容）
const SKIP_BOOKS = ['质控知识库']

// 无实质内容的章节黑名单
const SKIP_WORDS = [
    '概述', '前言', '附录', '目录', '总论', '总则', '参考文献', '索引', '后记',
    '序言', '致谢', '编写说明', '使用说明', '编写人员', '出版说明', '缩略语',
    '目 录', '说明', '序', '跋', '编委会', '名词术语',
]

// 宽泛标题（系统分类/科室/科目，不生成问题）
const SKIP_PATTERNS = [
    /系统/, // 呼吸系统疾病、心血管系统疾病
    /[科]$/, // 普外科、骨科、胸外科
    /学$/, // 症状学
    /类质控/, // A类质控知识
]

// 章节标题清洗（"第X章 高血压"→"高血压"；"J18 肺炎"→"肺炎"；"1. 发热"→"发热"）
const cleanTitle = (title) => {
    let t = (title || '').trim()
    t = t.replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分]+\s*/, '')
    t = t.replace(/^[A-Za-z]\d+(\.\d+)?\s*/, '') // ICD 编码前缀
    t = t.replace(/^\d+[\.、）)]\s*/, '')
    t = t.replace(/^[一二三四五六七八九十]+[、．.]\s*/, '') // 中文编号（"二、疾病特点"→"疾病特点"）
    t = t.replace(/^[（(][^（()）]*[)）]\s*/, '')
    t = t.replace(/[《》"“”]/g, '')
    return t.trim()
}

// 判断标题是否有实质内容
const isMeaningful = (title) => {
    if (title.length < 2 || title.length > 12) return false
    if (SKIP_WORDS.some(w => title.includes(w))) return false
    if (SKIP_PATTERNS.some(p => p.test(title))) return false
    if (/^[，。、；：！？,.!?;\s]+$/.test(title)) return false
    return true
}

// 按标题生成问题（分类模板）
const genQuestions = (title) => {
    const qs = []
    // 检查/检验类：只问临床意义
    if (/(检查|检验|CT|X线|B超|超声|解读)/.test(title)) {
        qs.push({ category: 'diagnosis', question: `${title}的临床意义是什么？` })
        return qs
    }
    // 标准/决策类标题（诊断标准/选择/方案/用药/分级/分类）：直接问要点
    if (/(诊断标准|标准|选择|方案|用药|治疗|分级|分类|原则)/.test(title)) {
        qs.push({ category: /诊断|标准|分级|分类/.test(title) ? 'diagnosis' : 'treatment', question: `${title}有哪些要点？` })
        return qs
    }
    // 普通疾病/症状：诊断标准 + 治疗原则
    qs.push({ category: 'diagnosis', question: `${title}的诊断标准是什么？` })
    qs.push({ category: 'treatment', question: `${title}的治疗原则是什么？` })
    return qs
}

const main = async () => {
    console.log('[gen-questions] 从知识库生成黄金题库...')

    // 取所有启用文档（含层级）
    const docs = await db('rag_source_doc')
        .select('id', 'title', 'level', 'parent_id')
        .where('enabled', true)
        .orderBy('id')

    const bookById = new Map()
    docs.forEach(d => { if (d.level === 0) bookById.set(d.id, d.title) })

    // 收集每本书的 level2 章节（具体疾病/症状/检查）
    const perBookCount = new Map()
    const questions = []

    // 三级结构书（书→章→节）：level1 是宽泛章（药物治疗/体格检查），只用 level2 具体节出题；
    // 两级书（书→章）：level1 即具体疾病，直接用 level1 出题
    const bookHasLevel2 = new Set()
    for (const d of docs) {
        if (d.level !== 2) continue
        const parent = docs.find(x => x.id === d.parent_id)
        if (!parent || parent.level !== 1) continue
        const book = docs.find(x => x.id === parent.parent_id)
        if (book && book.level === 0) bookHasLevel2.add(book.id)
    }

    // 候选章节：level1（两级书）或 level2（三级书）
    const candidates = []
    for (const d of docs) {
        if (d.level !== 1 && d.level !== 2) continue
        let bookId
        if (d.level === 1) {
            if (bookHasLevel2.has(d.parent_id)) continue
            bookId = d.parent_id
        } else {
            const parent = docs.find(x => x.id === d.parent_id)
            if (!parent || parent.level !== 1) continue
            bookId = parent.parent_id
        }
        if (!bookId || !bookById.has(bookId)) continue
        if (SKIP_BOOKS.includes(bookById.get(bookId))) continue
        candidates.push({ ...d, bookId })
    }

    // 章节启用段落数（0 段为空壳章节，数据缺失不出题）
    const passageCnt = {}
    const candRows = await db('rag_passage')
        .whereIn('doc_id', candidates.map(c => c.id))
        .where('enabled', true)
        .groupBy('doc_id')
        .count('* as c')
        .select('doc_id')
    candRows.forEach(r => { passageCnt[r.doc_id] = Number(r.c) })

    for (const d of candidates) {
        const bookId = d.bookId
        if ((perBookCount.get(bookId) || 0) >= 6) continue // 每本书最多 6 题
        if ((passageCnt[d.id] || 0) === 0) continue // 空壳章节（无内容）跳过

        const title = cleanTitle(d.title)
        if (!isMeaningful(title)) continue

        const qs = genQuestions(title)
        for (const q of qs) {
            // level1 章节（两级书）出题带书名上下文，避免"药物治疗有哪些要点？"丢失疾病名
            const question = d.level === 1 ? `${bookById.get(bookId)}的${q.question}` : q.question
            questions.push({
                id: `q${questions.length + 1}`,
                bookId,
                bookTitle: bookById.get(bookId),
                chapter: title,
                category: q.category,
                question,
                score: { accuracy: null, completeness: null, citation: null, format: null }, // 人工/LLM 评分（0-5）
                note: '', // 备注（如问题无效可标注）
            })
        }
        perBookCount.set(bookId, (perBookCount.get(bookId) || 0) + qs.length)
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), questions }, null, 2), 'utf8')

    // 汇总
    const byBook = {}
    questions.forEach(q => {
        byBook[q.bookTitle] = (byBook[q.bookTitle] || 0) + 1
    })
    console.log(`✅ 题库生成完成：${questions.length} 题（目标 40~60）`)
    console.log('按书分布：')
    Object.entries(byBook).forEach(([b, n]) => console.log(`  - ${b}: ${n} 题`))
    console.log(`\n输出文件：${OUT_FILE}`)
    console.log('提示：可人工编辑 questions.json 追加/修改问题，评测脚本直接读取。')

    await db.destroy()
}

main().catch(e => {
    console.error('生成失败:', e.message)
    process.exit(1)
})
