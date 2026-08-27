/**
 * make_qa_dataset_v2.js - med-qa v2 训练数据（四块：规则问答/判定样本/诚实样本/深度问答）
 * 1. 规则问答：290 条规则 × 6 种问法（模板，零成本）
 * 2. 判定样本：rules_v2 核查卡 35 个 yaml 的子质控点 → 判定+要点+豁免（模板，零成本）
 * 3. 诚实负样本：手写 50 条（知识外/截止后/内部/实时 → 明说不确定）
 * 4. 深度问答：精选治疗/机制类段落 200 条 → flash 强化 prompt（要求分点展开含药物/剂量/疗程）
 * 输出：finetune/qa_data/qa_dataset_v2.jsonl
 */
const fs = require('fs')
const path = require('path')
const { db } = require('../src/db')
const { callLLM } = require('../src/services/llm')
const settings = require('../src/services/settings')

const RULES_DIR = 'c:/在水医方/agent-qc-node-master/agent-qc-node/rules'
const V2_DIR = 'c:/在水医方/agent-qc-node-master/agent-qc-node/rules_v2'
const OUT_DIR = path.join(__dirname, '..', 'finetune', 'qa_data')

/** 解析规则 yaml（顶层字段: 值 / |- 块） */
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

/** 解析核查卡 v2：提取子质控点列表 [{code, name, points, exempt}] */
function parseV2Checklist(txt) {
    txt = txt.replace(/^\uFEFF/, '')
    const subs = []
    const lines = txt.split(/\r?\n/)
    let i = 0
    let cur = null
    const push = () => { if (cur && cur.code) { cur.points = cur.points.join(' ').trim(); cur.exempt = cur.exempt.join(' ').trim(); subs.push(cur) } cur = null }
    while (i < lines.length) {
        const l = lines[i]
        // 子质控点条目：- A001.001 名称
        const m = l.match(/^\s*-\s*([A-J]\d{3}\.\d{3})\s+(.+)$/)
        if (m) {
            push()
            cur = { code: m[1], name: m[2].trim(), points: [], exempt: [], mode: null }
            i++
            continue
        }
        if (cur) {
            const pm = l.match(/^\s*判定要点[:：]\s*(.*)$/)
            const em = l.match(/^\s*边界[\/／]豁免[:：]\s*(.*)$/)
            const gm = l.match(/^\s*质控要求[:：]\s*(.*)$/)
            if (pm) { cur.mode = 'points'; if (pm[1].trim()) cur.points.push(pm[1].trim()) }
            else if (em) { cur.mode = 'exempt'; if (em[1].trim()) cur.exempt.push(em[1].trim()) }
            else if (gm) { cur.mode = 'points'; if (gm[1].trim()) cur.points.push(gm[1].trim()) }
            else if (cur.mode && l.trim() && (l.startsWith(' ') || l.startsWith('\t'))) {
                // 当前区块续行（含 "- " 列表项），累积到对应数组
                const t = l.trim()
                if (cur.mode === 'points') cur.points.push(t)
                else cur.exempt.push(t)
            }
            else if (cur.mode && l.trim()) cur.mode = null // 遇到非缩进行，退出区块
        }
        i++
    }
    push()
    return subs
}

/** 规则问答：6 种问法 */
function ruleToQA(rule, cls) {
    const qas = []
    const code = rule['质控CODE']
    const name = rule['质控名称']
    const logic = rule['质控逻辑']
    const body = rule['质控规则']
    if (!body) return qas
    const answer = `${name}。质控逻辑：${logic || '无'}。质控规则：${body}`
    const templates = [
        `质控规则${code}（${name}）的具体要求是什么？`,
        `病历质控中，${name}是怎么判定的？`,
        `${cls}类质控规则中，${name}的检查要点有哪些？`,
        `请说明${name}的质控要求。`,
        `${name}的质控逻辑和规则是什么？`,
        `病历书写时，${name}需要注意什么？`,
    ]
    for (const q of templates) qas.push({ q, a: answer })
    return qas
}

/** 判定样本：子质控点 → 判定问答 */
function subToQA(sub, cls) {
    const qas = []
    const a = `判定标准：${sub.points}${sub.exempt ? ' 边界/豁免：' + sub.exempt : ''}`
    qas.push({ q: `病历质控中，${sub.name}这类问题怎么判定？`, a })
    qas.push({ q: `${sub.name}，属于质控缺陷的情形有哪些？`, a })
    return qas
}

/** flash 生成深度问答（强化 prompt：要求展开细节） */
async function deepQA(content, title, idx, model) {
    const prompt = `你是医学知识专家。请根据下面的医学知识段落，生成 1 个高质量的问答对。

## 知识段落（来自《${title}》）
${content.slice(0, 900)}

## 要求
- 问题：医生会真实问的问题（如"X 的治疗原则/用药方案/诊断标准是什么？"）
- 回答：**必须完整展开**——分点列出，包含段落中出现的具体药物名称、剂量、疗程、适应证、禁忌等细节，不要只给要点标题
- 只使用段落中的信息，不要编造
- 输出严格 JSON：{"q": "问题", "a": "回答（200字以上）"}` 
    try {
        const text = await callLLM([{ role: 'user', content: prompt }], model, { temperature: 0.4, maxTokens: 900, timeoutMs: 40000 })
        if (!text) return null
        const m = text.match(/\{[\s\S]*\}/)
        if (!m) return null
        const parsed = JSON.parse(m[0])
        if (parsed.q && parsed.a && parsed.a.length > 100) return { q: parsed.q, a: parsed.a }
    } catch (e) { console.log(`深度问答失败 #${idx}: ${e.message.slice(0, 60)}`) }
    return null
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const out = []

    // 1. 规则问答（6 种问法）
    const files = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.yaml'))
    let ruleCount = 0
    for (const f of files) {
        const r = parseRuleYaml(fs.readFileSync(path.join(RULES_DIR, f), 'utf8'))
        const cls = f.split('.')[0]
        for (const qa of ruleToQA(r, cls)) { out.push(qa); ruleCount++ }
    }
    console.log('① 规则问答对:', ruleCount)

    // 2. 判定样本（v2 核查卡子质控点）
    const v2files = fs.readdirSync(V2_DIR).filter(f => f.endsWith('.yaml'))
    let judgeCount = 0
    for (const f of v2files) {
        const subs = parseV2Checklist(fs.readFileSync(path.join(V2_DIR, f), 'utf8'))
        const cls = f.split(' ')[0]
        for (const sub of subs) {
            if (!sub.points) continue
            for (const qa of subToQA(sub, cls)) { out.push(qa); judgeCount++ }
        }
    }
    console.log('② 判定样本:', judgeCount, `（来自 ${v2files.length} 个核查卡）`)

    // 3. 诚实负样本（手写 50 条：指南更新/新药/医保/政策/内部/实时/未来）
    const honest = [
        ['2025年发布的《中国高血压防治指南》相比旧版有什么更新？', '我的知识更新有截止时间，没有收录 2025 年发布的指南内容，无法回答该版本的具体更新。请以最新官方指南原文为准。'],
        ['最近两年新获批的抗肿瘤药物有哪些？', '我不确定，我的知识库中没有收录最近两年新获批药物的完整信息。为避免给出错误信息，请查阅国家药监局最新批件或权威药学资讯。'],
        ['最新的医保药品目录调整后有哪些新变化？', '我不确定。医保目录调整信息时效性强，我的知识中没有最新版目录的具体变化。请以国家医保局发布的正式目录为准。'],
        ['你们医院最近的质控考核标准是什么？', '我不确定。医院内部考核标准属于机构内部信息，我的知识库中没有相关内容，请咨询医院质控部门。'],
        ['2025年发布的《中国2型糖尿病防治指南》有哪些更新？', '我的知识中没有收录 2025 年版《中国2型糖尿病防治指南》，无法回答其更新内容。请以中华医学会糖尿病学分会发布的最新指南为准。'],
        ['2026年新修订的《医疗质量安全核心制度要点》变化是什么？', '我不确定。该文件的最新修订内容在我的知识截止日期之后，我没有收录，请查阅国家卫健委官方发布。'],
        ['最近国家卫健委新发布的病历书写规范是什么？', '我不确定。我的知识中没有收录最近发布的病历书写规范文件，请以国家卫健委官网最新通知为准。'],
        ['DRG/DIP 付费 2026 年最新政策有什么变化？', '我不确定。医保支付方式改革政策更新频繁，我的知识中没有 2026 年最新政策内容，请查阅国家医保局官方文件。'],
        ['今天门诊量统计是多少？', '我无法获取实时数据。医院运行数据属于实时信息，请查看医院信息系统。'],
        ['我们科室上个月的质控得分是多少？', '我不确定。科室质控得分属于内部实时数据，我的知识库中没有，请查询医院质控系统。'],
        ['最新的抗生素耐药监测数据是多少？', '我不确定。耐药监测数据需要实时更新，我的知识中没有最新数据，请参考全国细菌耐药监测网（CARSS）发布。'],
        ['2026年诺贝尔生理学或医学奖颁给了谁？', '我的知识截止时间早于该奖项公布时间，无法回答。请查阅最新新闻。'],
        ['明天会有什么新的医疗政策发布吗？', '我无法预测未来事件。政策发布属于实时信息，请关注官方渠道。'],
        ['《中国心力衰竭诊断和治疗指南》2026年版有什么新内容？', '我不确定。我的知识中没有收录 2026 年版指南，无法回答其具体内容，请以官方发布为准。'],
        ['最近批准的国产创新药有哪些？', '我不确定。新药审批信息时效性强，我的知识中没有最新获批名单，请查阅国家药监局药品审评中心公告。'],
        ['2025版《抗菌药物临床应用指导原则》修订了哪些内容？', '我的知识中没有收录 2025 版《抗菌药物临床应用指导原则》的修订内容，请以国家卫健委发布的最新版为准。'],
        ['最新版《医疗机构病历管理规定》是哪一年发布的？', '我不确定。我的知识截止后该规定可能有过修订，请查阅国家卫健委官网确认最新版本。'],
        ['昨天热搜上的那个医疗事件是什么？', '我无法获取实时新闻。热点事件属于实时信息，请查阅新闻媒体。'],
        ['你们平台总共收录了多少本书？', '我不确定。平台知识库的动态数据请查看系统统计页面，我的训练数据中不包含实时统计。'],
        ['2026年医师资格考试时间安排是什么？', '我不确定。考试安排每年发布，我的知识中没有 2026 年考试时间，请以国家医学考试中心通知为准。'],
        ['最新的《处方管理办法》修订内容？', '我的知识中没有收录该办法的最新修订，请查阅国家卫健委官方文件。'],
        ['2025年更新的高血压分级标准是什么？', '我的知识更新有截止时间，2025 年之后的标准变化我没有收录。目前我掌握的是旧版标准，请以最新指南为准。'],
        ['最近新增的医保谈判药品有哪些？', '我不确定。医保谈判药品名单每年更新，我的知识中没有最新名单，请查阅国家医保局公告。'],
        ['2026年国家医疗质量安全改进目标是什么？', '我不确定。年度改进目标在每年初发布，我的知识中没有 2026 年版，请以国家卫健委发布为准。'],
        ['最新的疫苗接种程序是什么？', '我不确定。免疫规划程序会不定期更新，我的知识中可能不是最新版本，请咨询疾控中心或查阅最新官方文件。'],
        ['上季度我院的 VTE 预防率是多少？', '我不确定。院内质量指标属于内部实时数据，请查询医院质控或运营系统。'],
        ['2025年世界卫生组织发布的新版基本药物清单变化？', '我的知识中没有收录 2025 年版基本药物清单的更新，请以 WHO 官网发布为准。'],
        ['最新的中医病历书写规范是什么？', '我不确定。中医病历相关规范如有更新，我的知识中没有收录最新版，请查阅国家中医药管理局官方文件。'],
        ['2026年新出台的医疗反腐政策？', '我不确定。政策文件的最新动态在我的知识截止日期之后，请查阅官方发布渠道。'],
        ['最近发生的重大医疗事故通报内容？', '我无法获取实时通报。具体通报内容属于实时信息，请查阅国家卫健委或当地卫健委官网。'],
        ['最新的护理文书书写规范更新？', '我不确定。护理文书规范如有最新修订，我的知识中没有收录，请以官方发布为准。'],
        ['2025年发布的《中国慢性阻塞性肺疾病诊治指南》更新要点？', '我的知识中没有收录 2025 年版 COPD 诊治指南，无法回答更新要点，请以中华医学会呼吸病学分会发布为准。'],
        ['新出台的互联网诊疗监管细则有哪些？', '我不确定。互联网诊疗监管政策更新较快，我的知识中没有最新细则，请查阅国家卫健委官方文件。'],
        ['2026年住院医师规范化培训政策有什么变化？', '我不确定。规培政策如有最新调整，我的知识中没有收录，请以国家卫健委科教司发布为准。'],
        ['最新版的病案首页填写规范？', '我的知识中收录的病案首页填写规范可能不是最新版，请以国家卫健委最新发布为准。'],
        ['上个月全国新发传染病疫情数据？', '我无法获取实时疫情数据。请查阅中国疾控中心官方发布的疫情信息。'],
        ['2025年更新的《药品管理法》相关细则？', '我不确定。药品管理相关法规细则的更新在我的知识截止日期之后，请查阅国家药监局官方文件。'],
        ['最新的医院等级评审标准是什么？', '我不确定。医院等级评审标准如有新版，我的知识中没有收录，请以国家卫健委评审标准为准。'],
        ['2026年医保支付方式改革试点城市名单？', '我不确定。试点名单动态调整，我的知识中没有最新名单，请查阅国家医保局官方发布。'],
        ['最近获批上市的新冠疫苗有什么？', '我不确定。疫苗审批信息时效性强，我的知识中没有最新获批信息，请查阅国家药监局公告。'],
        ['最新的抗菌药物分级管理目录？', '我的知识中收录的分级管理目录可能不是最新版，请以国家卫健委最新发布为准。'],
        ['2025年发布的《中国急性心肌梗死诊断和治疗指南》更新？', '我的知识中没有收录 2025 年版急性心梗指南，无法回答其更新内容，请以最新官方发布为准。'],
        ['最新的临床路径管理规范？', '我不确定。临床路径规范如有更新，我的知识中没有收录最新版，请以国家卫健委发布为准。'],
        ['2026年医务人员职称评审新政策？', '我不确定。职称评审政策如有最新调整，请以当地卫健委和人社部门发布为准。'],
        ['最近出台的医疗数据安全法规？', '我不确定。医疗数据安全相关法规的最新动态在我的知识截止日期之后，请查阅国家网信办和卫健委官方文件。'],
        ['最新的手术分级管理目录？', '我的知识中收录的手术分级目录可能不是最新版，请以国家卫健委最新发布为准。'],
        ['2025年世界卫生组织更新的高血压治疗建议？', '我的知识中没有收录 2025 年 WHO 更新的高血压治疗建议，无法回答，请查阅 WHO 官方指南。'],
        ['最新的医联体建设政策？', '我不确定。医联体政策如有最新调整，请以国家卫健委发布为准。'],
        ['2026年基层医疗能力提升项目有哪些？', '我不确定。年度项目安排属于政策动态，我的知识中没有 2026 年项目内容，请查阅官方发布。'],
        ['最近发布的医疗器械监管新规？', '我不确定。医疗器械监管法规的更新在我的知识截止日期之后，请查阅国家药监局官方文件。'],
    ]
    for (const [q, a] of honest) out.push({ q, a })
    console.log('③ 诚实负样本:', honest.length)

    // 4. 深度问答：精选治疗/机制类段落（非质控书 + 内容关键词过滤）
    const kwFilter = /治疗|用药|剂量|疗程|适应证|禁忌|机制|诊断标准|分级|方案|预防|康复|管理/
    const passages = await db('rag_passage as p')
        .join('rag_source_doc as d', 'p.doc_id', 'd.id')
        .where('p.enabled', true)
        .whereNotIn('d.title', ['住院病历质控核查卡', '住院病历质控规则库', '医疗编码规则库'])
        .orderByRaw('random()')
        .limit(1200)
        .select('p.content', db.raw('COALESCE(bk.title, d.title) as book_title'))
        .leftJoin('rag_source_doc as bk', 'bk.id', 'd.parent_id')
    const deepPassages = passages.filter(p => kwFilter.test(p.content || '')).slice(0, 200)
    console.log('④ 深度问答: 精选段落', deepPassages.length, '（过滤后）')
    let deepCount = 0
    const { model: fastModel } = await settings.getLLM()
    for (let i = 0; i < deepPassages.length; i++) {
        const p = deepPassages[i]
        const qa = await deepQA(p.content, p.book_title || '医学资料', i, fastModel)
        if (qa) { out.push(qa); deepCount++ }
        if ((i + 1) % 40 === 0) console.log(`   深度问答进度: ${i + 1}/${deepPassages.length} (ok=${deepCount})`)
    }
    console.log('④ 深度问答对:', deepCount)

    // 写入 jsonl（去重）
    const seen = new Set()
    const dedup = out.filter(x => { const k = x.q; if (seen.has(k)) return false; seen.add(k); return true })
    const file = path.join(OUT_DIR, 'qa_dataset_v2.jsonl')
    fs.writeFileSync(file, dedup.map(x => JSON.stringify({ instruction: x.q, output: x.a })).join('\n'), 'utf8')
    console.log(`\n写入 ${file}: ${dedup.length} 条`)
    console.log('分布：规则', ruleCount, '/ 判定', judgeCount, '/ 诚实', honest.length, '/ 深度', deepCount)
    process.exit(0)
}

main().catch(e => { console.error('失败:', e.message); process.exit(1) })
