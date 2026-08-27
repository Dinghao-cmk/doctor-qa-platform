/**
 * generate_rag_data.js - 从知识库自动生成 RAG 微调训练数据
 *
 * 流程：
 *   遍历知识库章节（有段落的章节）→ 用强模型生成医生问题 → 用强模型生成带引用标准回答
 *   输出 alpaca 格式 jsonl（instruction + input + output），兼容 LLaMA-Factory
 *
 * 用法：
 *   node finetune/generate_rag_data.js                    # 全量生成
 *   node finetune/generate_rag_data.js --limit 5          # 只处理前 5 个章节（验证质量）
 *   node finetune/generate_rag_data.js --per-chapter 1    # 每章生成 1 个问题
 *
 * 生成模型（环境变量覆盖，默认用 settings 的强模型）：
 *   GEN_MODEL   模型名（如 gemini-2.5-pro / deepseek-reasoner）
 *   GEN_API_URL 端点（如 https://api.openai-proxy.org/v1/chat/completions）
 *   GEN_API_KEY 密钥
 */
const fs = require('fs')
const path = require('path')
const { db } = require('../src/db')
const { callLLM } = require('../src/services/llm')
const settings = require('../src/services/settings')

const OUT = path.join(__dirname, 'rag_train.jsonl')

// 跳过非医学内容
const SKIP_BOOKS = ['质控知识库']

// 生成模型配置（环境变量优先，默认走 settings 强模型）
const GEN_MODEL = process.env.GEN_MODEL || ''
const GEN_API_URL = process.env.GEN_API_URL || ''
const GEN_API_KEY = process.env.GEN_API_KEY || ''

// 系统指令（微调后与线上 system prompt 保持一致，保证同 prompt 可触发）
const INSTRUCTION = '你是一位专业的医学知识问答助手，服务于临床医生。回答必须严格基于提供的参考资料，每个要点标注 [参考N]，不编造、不补充资料外的内容，不确定处如实说明。'

/** 章节标题清洗（去"第X章"、ICD 编码前缀等） */
const cleanTitle = (t) => {
    let s = (t || '').trim()
    s = s.replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分]+\s*/, '')
    s = s.replace(/^[A-Za-z]\d+(\.\d+)?\s*/, '')
    s = s.replace(/^\d+[\.、）)]\s*/, '')
    s = s.replace(/^[一二三四五六七八九十]+[、．.]\s*/, '')
    s = s.replace(/^[（(][^（()）]*[)）]\s*/, '')
    s = s.replace(/[《》"“”]/g, '')
    return s.trim()
}

/** 从 LLM 文本中提取 JSON 数组（容错处理 ```json 包裹） */
const parseJsonArray = (text) => {
    if (!text) return []
    const m = text.match(/\[[\s\S]*\]/)
    if (!m) return []
    try {
        const arr = JSON.parse(m[0])
        return Array.isArray(arr) ? arr : []
    } catch {
        return []
    }
}

/** 构建参考资料文本（章节段落，每段截断控制长度） */
const buildContext = (bookTitle, chapterTitle, passages) => {
    const content = passages.map((p, i) => {
        const t = (p || '').trim().slice(0, 400)
        return t
    }).join('\n')
    return `【参考1】《${bookTitle}》${chapterTitle}\n${content}`
}

/** Step 1: 生成医生问题 */
const generateQuestions = async (title, content, count, genCfg) => {
    const prompt = `你是临床医学教学助手。请根据下面医学教材章节的内容，生成 ${count} 个临床医生最可能提出的问题。

要求：
- 问题要具体、符合临床医生真实提问方式（如"XX的诊断标准是什么""XX的治疗原则""XX的用药选择"等）
- 覆盖不同提问角度（诊断、治疗、用药、鉴别、禁忌、临床表现等），不要重复
- 每个问题都必须能从给定内容中找到明确答案
- 直接输出 JSON 数组，不要任何其他文字：["问题1", "问题2"]

章节：${title}
内容：
${content}`

    const answer = await callLLM(
        [{ role: 'user', content: prompt }],
        genCfg.model,
        { apiUrl: genCfg.apiUrl, apiKey: genCfg.apiKey, temperature: 0.3, maxTokens: 800, timeoutMs: 60000 }
    )
    return parseJsonArray(answer)
}

/** Step 2: 生成带引用的标准回答 */
const generateAnswer = async (question, context, genCfg) => {
    const prompt = `你是一名临床医学知识助手，根据参考资料回答医生的问题。

## 参考资料
${context}

## 问题
${question}

## 要求
- 严格基于参考资料回答，不编造、不补充资料外的知识
- 每个要点/分点标注 [参考1]
- 分点条理清晰，语言简洁，直接回答不寒暄
- 控制在 400 字以内`

    const answer = await callLLM(
        [{ role: 'system', content: INSTRUCTION }, { role: 'user', content: prompt }],
        genCfg.model,
        { apiUrl: genCfg.apiUrl, apiKey: genCfg.apiKey, temperature: 0.2, maxTokens: 1500, timeoutMs: 60000 }
    )
    return (answer || '').trim()
}

const main = async () => {
    // 参数解析
    const args = process.argv.slice(2)
    const getArg = (name, def) => {
        const i = args.indexOf(name)
        return i >= 0 && args[i + 1] ? args[i + 1] : def
    }
    const limit = parseInt(getArg('--limit', '0'), 10)
    const perChapter = parseInt(getArg('--per-chapter', '2'), 10)

    // 生成模型配置
    const llm = await settings.getLLM()
    const genCfg = {
        model: GEN_MODEL || llm.strongModel,
        apiUrl: GEN_API_URL || llm.apiUrl,
        apiKey: GEN_API_KEY !== '' ? GEN_API_KEY : llm.apiKey,
    }
    console.log(`生成模型: ${genCfg.model} (${genCfg.apiUrl})`)

    // 1. 取文档树 + 段落
    const docs = await db('rag_source_doc').select('id', 'title', 'level', 'parent_id')
        .where('enabled', true).orderBy('id')
    const bookById = new Map(docs.filter(d => d.level === 0).map(d => [d.id, d.title]))

    // 章节：level1（两级书）或 level2（三级书），排除宽泛章节
    const chapters = []
    const bookHasLevel2 = new Set()
    for (const d of docs) {
        if (d.level !== 2) continue
        const p = docs.find(x => x.id === d.parent_id)
        if (p && p.level === 1) {
            const b = docs.find(x => x.id === p.parent_id)
            if (b && b.level === 0) bookHasLevel2.add(b.id)
        }
    }
    for (const d of docs) {
        if (d.level !== 1 && d.level !== 2) continue
        let bookId
        if (d.level === 1) {
            if (bookHasLevel2.has(d.parent_id)) continue
            bookId = d.parent_id
        } else {
            const p = docs.find(x => x.id === d.parent_id)
            if (!p || p.level !== 1) continue
            bookId = p.parent_id
        }
        if (!bookId || !bookById.has(bookId)) continue
        if (SKIP_BOOKS.includes(bookById.get(bookId))) continue
        chapters.push({ ...d, bookId })
    }

    // 段落按章节分组（每章最多取 3 段）
    const passageByChapter = new Map()
    const passages = await db('rag_passage')
        .select('doc_id', 'content')
        .whereIn('doc_id', chapters.map(c => c.id))
        .where('enabled', true)
        .orderBy('id')
    for (const p of passages) {
        if (!passageByChapter.has(p.doc_id)) passageByChapter.set(p.doc_id, [])
        if (passageByChapter.get(p.doc_id).length < 3) passageByChapter.get(p.doc_id).push(p.content)
    }

    const usable = chapters.filter(c => (passageByChapter.get(c.id) || []).length > 0)
    const target = limit > 0 ? usable.slice(0, limit) : usable
    console.log(`有内容章节: ${usable.length} 个，本次处理 ${target.length} 个（每章 ${perChapter} 问）`)

    // 2. 遍历生成
    const samples = []
    let ok = 0
    for (let i = 0; i < target.length; i++) {
        const c = target[i]
        const bookTitle = bookById.get(c.bookId)
        const chapterTitle = cleanTitle(c.title)
        const paras = passageByChapter.get(c.id)
        if (!chapterTitle || chapterTitle.length < 2 || chapterTitle.length > 20) continue

        const context = buildContext(bookTitle, chapterTitle, paras)
        process.stdout.write(`\r[${i + 1}/${target.length}] ${bookTitle} / ${chapterTitle}`)

        try {
            // 生成问题
            const questions = await generateQuestions(chapterTitle, paras.slice(0, 3).join('\n'), perChapter, genCfg)
            if (questions.length === 0) continue

            for (const q of questions) {
                if (!q || q.length < 5) continue
                const answer = await generateAnswer(q, context, genCfg)
                if (!answer || answer.length < 20) continue
                samples.push({
                    instruction: INSTRUCTION,
                    input: `## 参考资料\n${context}\n\n## 问题\n${q}`,
                    output: answer,
                })
                ok++
            }
        } catch (e) {
            console.error(`\n[生成失败] ${chapterTitle}: ${e.message}`)
        }
    }
    process.stdout.write('\n')

    // 3. 写文件（jsonl）
    const lines = samples.map(s => JSON.stringify(s, null, 0)).join('\n')
    fs.writeFileSync(OUT, lines + '\n', 'utf8')
    console.log(`✅ 生成 ${samples.length} 条训练样本 → ${OUT}`)
    await db.destroy()
}

main().catch(e => { console.error('失败:', e.message); process.exit(1) })
