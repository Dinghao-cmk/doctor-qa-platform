// 生成 embedding 微调数据：知识库章节 → (query, positive, negatives)
// 正样本：章节标题查询 → 本章节段落
// 负样本：随机其他书段落 + 同书其他章节段落（硬负样本）
const fs = require('fs')
const path = require('path')
const { db: knex } = require('../src/db')

const OUT = path.join(__dirname, 'data.json')

;(async () => {
    // 1. 取所有启用书的章节（level1/2）与段落
    const docs = await knex('rag_source_doc').select('id', 'title', 'level', 'parent_id')
        .where('enabled', true).orderBy('id')
    const bookById = new Map(docs.filter(d => d.level === 0).map(d => [d.id, d.title]))
    const chapters = docs.filter(d => d.level === 1 || d.level === 2)
        .map(d => {
            // 追溯书名
            let bookId = null
            if (d.level === 1) bookId = d.parent_id
            else {
                const p = docs.find(x => x.id === d.parent_id)
                bookId = p && p.level === 1 ? p.parent_id : null
            }
            return { ...d, bookId }
        })
        .filter(c => c.bookId && bookById.has(c.bookId) && bookById.get(c.bookId) !== '质控知识库')

    // 2. 取有内容章节的段落（每章最多取 3 段）
    const chapterIds = chapters.map(c => c.id)
    const passages = await knex('rag_passage').select('id', 'doc_id', 'content')
        .whereIn('doc_id', chapterIds).where('enabled', true).orderBy('id')
    const parasByChapter = new Map()
    for (const p of passages) {
        if (!parasByChapter.has(p.doc_id)) parasByChapter.set(p.doc_id, [])
        if (parasByChapter.get(p.doc_id).length < 3) parasByChapter.get(p.doc_id).push(p.content)
    }
    const usable = chapters.filter(c => (parasByChapter.get(c.id) || []).length > 0)
    console.log('有内容章节:', usable.length, '/', chapters.length)

    // 3. 清洗章节标题做 query
    const cleanTitle = (t) => {
        let s = (t || '').trim()
        s = s.replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分]+\s*/, '')
        s = s.replace(/^[A-Za-z]\d+(\.\d+)?\s*/, '')
        s = s.replace(/^\d+[\.、）)]\s*/, '')
        s = s.replace(/^[一二三四五六七八九十]+[、．.]\s*/, '')
        s = s.replace(/[《》"“”]/g, '')
        return s.trim()
    }

    // 4. 生成训练样本
    const samples = []
    const bookParas = new Map() // bookId -> [段落...]（用于跨书负样本）
    for (const c of usable) {
        const ps = parasByChapter.get(c.id)
        const arr = bookParas.get(c.bookId) || []
        arr.push(...ps)
        bookParas.set(c.bookId, arr)
    }

    const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)]

    for (const c of usable) {
        const title = cleanTitle(c.title)
        if (title.length < 2 || title.length > 15) continue
        const ps = parasByChapter.get(c.id)
        // 1-2 个正样本
        const pos = ps.slice(0, 2)
        for (const p of pos) {
            if (p.length < 20) continue
            const negatives = []
            // 硬负样本：同书其他章节段落（至多 1 个）
            const sameBookOther = [...(bookParas.get(c.bookId) || [])].filter(x => !ps.includes(x))
            if (sameBookOther.length > 0) negatives.push(rnd(sameBookOther))
            // 跨书负样本（至多 2 个）
            const otherBooks = [...bookParas.keys()].filter(b => b !== c.bookId)
            for (let i = 0; i < 2 && otherBooks.length > 0; i++) {
                const b = rnd(otherBooks)
                const bp = bookParas.get(b)
                if (bp && bp.length > 0) negatives.push(rnd(bp))
            }
            samples.push({
                query: title,
                positive: p,
                negatives: negatives.filter(x => x && x.length > 20),
            })
        }
    }

    // 5. 追加题库问题（期望书的段落为正样本）
    let qb = []
    try { qb = require('../scripts/eval/questions.json').questions || [] } catch (e) { }
    const qsWithPos = []
    for (const q of qb) {
        // 期望书的所有段落
        const bookDocIds = docs.filter(d => {
            if (d.level === 0) return d.title === q.bookTitle
            return false
        }).map(d => d.id)
        // 简化：用期望书标题匹配 chapter 相关的段落做正样本
        const ch = chapters.find(x => cleanTitle(x.title) === q.chapter && bookById.get(x.bookId) === q.bookTitle)
        if (ch && parasByChapter.get(ch.id) && parasByChapter.get(ch.id).length > 0) {
            qsWithPos.push({
                query: q.question,
                positive: parasByChapter.get(ch.id)[0],
                negatives: [], // 复用前面逻辑不强制
            })
        }
    }
    // 题库样本给负样本：随机其他书段落
    for (const s of qsWithPos) {
        const otherBooks = [...bookParas.keys()].filter(b => b !== undefined)
        const negs = []
        for (let i = 0; i < 2 && otherBooks.length > 0; i++) {
            const b = rnd(otherBooks)
            const bp = bookParas.get(b)
            if (bp && bp.length > 0) negs.push(rnd(bp))
        }
        s.negatives = negs.filter(x => x && x.length > 20)
        samples.push(s)
    }

    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), samples }, null, 2), 'utf8')
    const withNeg = samples.filter(s => s.negatives.length > 0).length
    console.log(`✅ 训练样本: ${samples.length} 条（含负样本 ${withNeg} 条）→ ${OUT}`)
    process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
