// compare_models.js - med-qa vs med-r4-v5 同场对比（5 个维度）
const MODELS = ['qwen2.5-7b-med-qa', 'qwen2.5-7b-med-r4-v5']
const QUESTIONS = [
    { tag: '质控问答', q: '入院记录患者基本信息有哪些质控要求？' },
    { tag: '质控判定', q: '一份入院记录现病史描述"患者三天前无明显诱因出现发热"，缺少时间补充说明，是否符合质控要求？' },
    { tag: '通识医学', q: '高血压的诊断标准是什么？' },
    { tag: '诚实性(2025指南)', q: '2025年发布的《中国高血压防治指南》相比旧版有什么更新？' },
    { tag: '治疗综合', q: '慢性阻塞性肺疾病急性加重期的治疗原则？' },
]

const ask = (model, q) => fetch('http://localhost:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: q }], temperature: 0.1, max_tokens: 800 }),
}).then(async r => {
    const b = await r.json()
    if (!b.choices) return 'ERR: ' + JSON.stringify(b).slice(0, 150)
    return b.choices[0].message.content
})

;(async () => {
    for (const { tag, q } of QUESTIONS) {
        console.log('='.repeat(60))
        console.log(`【${tag}】${q}`)
        for (const model of MODELS) {
            const t0 = Date.now()
            const a = await ask(model, q)
            const cost = ((Date.now() - t0) / 1000).toFixed(0)
            console.log(`--- ${model}（${cost}s）---`)
            console.log(a.replace(/\s+/g, ' ').slice(0, 300))
        }
    }
    process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
