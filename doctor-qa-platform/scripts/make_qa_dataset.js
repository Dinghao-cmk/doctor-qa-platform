/**
 * make_qa_dataset.js - 用真实内容生成问答训练数据
 * 1. 质控规则（290 条 yaml）→ 规则问答对（确定性生成，零 API 成本）
 * 2. 知识库真实段落（精选）→ LLM 生成问答对（云端 flash）
 * 3. 诚实负样本（知识外问题 → 明确说不确定）
 * 输出：finetune/qa_data/qa_dataset.jsonl
 */
const fs = require('fs')
const path = require('path')
const { db } = require('../src/db')
const { callLLM } = require('../src/services/llm')
const settings = require('../src/services/settings')

const RULES_DIR = 'c:/在水医方/agent-qc-node-master/agent-qc-node/rules'
const OUT_DIR = path.join(__dirname, '..', 'finetune', 'qa_data')

/** 解析规则 yaml（同 convert 脚本） */
function parseRuleYaml(txt) {
    txt = txt.replace(/^\uFEFF/, '')
    const rule = {}
    const lines = txt.split(/\r?\n/)
    let i = 0
    while (i < lines.length) {
        const m = lines[i].match(/^(\S+?):\s*(.*)$/)
        if (m) {
            const key = m[1]
            const val = m[2]
            if (val === '|-' || val === '|') {
                const block = []
                i++
                while (i < lines.length) {
                    const l = lines[i]
                    if (l.startsWith('  ') || l.startsWith('\t') || l.trim() === '') { block.push(l.replace(/^ {2}/, '')); i++ }
                    else break
                }
                rule[key] = block.join('\n').trim()
            } else { rule[key] = val.trim(); i++ }
        } else i++
    }
    return rule
}

/** 规则 → 问答对（真实内容，问题模板多样化） */
function ruleToQA(rule, cls) {
    const qas = []
    const code = rule['质控CODE']
    const name = rule['质控名称']
    const logic = rule['质控逻辑']
    const body = rule['质控规则']
    if (!body) return qas
    const answer = `${name}。质控逻辑：${logic || '无'}。质控规则：${body}`
    // 3 种问题模板（同义变换提升泛化）
    const templates = [
        `质控规则${code}（${name}）的具体要求是什么？`,
        `病历质控中，${name}是怎么判定的？`,
        `${cls}类质控规则中，${name}的检查要点有哪些？`,
    ]
    for (const q of templates) qas.push({ q, a: answer })
    return qas
}

/** LLM 从段落生成问答对 */
async function passageToQA(content, title, idx, model) {
    const prompt = `你是医学知识专家。请根据下面的医学知识段落，生成 1 个高质量的问答对（医生会问的问题 + 基于段落内容的准确回答）。\n\n## 知识段落（来自《${title}》）\n${content.slice(0, 800)}\n\n## 输出格式（严格 JSON）\n{"q": "问题", "a": "回答"}\n回答要完整准确，只使用段落中的信息，不要编造。`
    try {
        const text = await callLLM([{ role: 'user', content: prompt }], model, { temperature: 0.4, maxTokens: 600, timeoutMs: 30000 })
        if (!text) return null
        const m = text.match(/\{[\s\S]*\}/)
        if (!m) return null
        const parsed = JSON.parse(m[0])
        if (parsed.q && parsed.a) return { q: parsed.q, a: parsed.a }
    } catch (e) { console.log(`LLM 生成失败 #${idx}: ${e.message.slice(0, 60)}`) }
    return null
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const out = []

    // 1. 规则问答（确定性）
    const files = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.yaml'))
    let ruleCount = 0
    for (const f of files) {
        const r = parseRuleYaml(fs.readFileSync(path.join(RULES_DIR, f), 'utf8'))
        const cls = f.split('.')[0]
        for (const qa of ruleToQA(r, cls)) {
            out.push({ q: qa.q, a: qa.a })
            ruleCount++
        }
    }
    console.log('规则问答对:', ruleCount)

    // 2. 书籍段落 → LLM 问答（精选 300 段：质控规则库 + 编码 + 真实医学书，避免重复段）
    const passages = await db('rag_passage as p')
        .join('rag_source_doc as d', 'p.doc_id', 'd.id')
        .where('p.enabled', true)
        .whereNotIn('d.title', ['住院病历质控核查卡']) // 核查卡与规则重复
        .orderByRaw('random()')
        .limit(300)
        .select('p.content', db.raw('COALESCE(bk.title, d.title) as book_title'))
        .leftJoin('rag_source_doc as bk', 'bk.id', 'd.parent_id')
    console.log('精选段落:', passages.length)
    let llmCount = 0
    const { model: fastModel } = await settings.getLLM()
    for (let i = 0; i < passages.length; i++) {
        const p = passages[i]
        const qa = await passageToQA(p.content, p.book_title || '医学资料', i, fastModel)
        if (qa) { out.push(qa); llmCount++ }
        if ((i + 1) % 50 === 0) console.log(`LLM QA 进度: ${i + 1}/${passages.length} (ok=${llmCount})`)
    }
    console.log('LLM 问答对:', llmCount)

    // 3. 诚实负样本（知识外/截止后 → 明说不确定）
    const honestSamples = [
        { q: '2025年发布的《中国高血压防治指南》相比旧版有什么更新？', a: '我的知识更新有截止时间，没有收录 2025 年发布的指南内容，无法回答该版本的具体更新。请以最新官方指南原文为准。' },
        { q: '最近两年新获批的抗肿瘤药物有哪些？', a: '我不确定，我的知识库中没有收录最近两年新获批药物的完整信息。为避免给出错误信息，请查阅国家药监局最新批件或权威药学资讯。' },
        { q: '最新的医保药品目录调整后有哪些新变化？', a: '我不确定。医保目录调整信息时效性强，我的知识中没有最新版目录的具体变化。请以国家医保局发布的正式目录为准。' },
        { q: '你们医院最近的质控考核标准是什么？', a: '我不确定。医院内部考核标准属于机构内部信息，我的知识库中没有相关内容，请咨询医院质控部门。' },
    ]
    for (const s of honestSamples) out.push(s)
    console.log('诚实负样本:', honestSamples.length)

    // 写入 jsonl（去重）
    const seen = new Set()
    const dedup = out.filter(x => { const k = x.q; if (seen.has(k)) return false; seen.add(k); return true })
    const file = path.join(OUT_DIR, 'qa_dataset.jsonl')
    fs.writeFileSync(file, dedup.map(x => JSON.stringify({ instruction: x.q, output: x.a })).join('\n'), 'utf8')
    console.log(`写入 ${file}: ${dedup.length} 条`)
    process.exit(0)
}

main().catch(e => { console.error('失败:', e.message); process.exit(1) })
