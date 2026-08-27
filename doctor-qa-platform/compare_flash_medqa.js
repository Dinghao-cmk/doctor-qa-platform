// compare_flash_medqa.js - flash(完整RAG) vs med-qa(localrag) 同场对比
const test = async (label, question) => {
    console.log('='.repeat(56))
    console.log(`【${label}】${question}`)
    // flash 完整 RAG
    try {
        const t0 = Date.now()
        const r1 = await fetch('http://localhost:3012/api/ask/stream', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, regen: true }),
        })
        const t1 = await r1.text()
        const d1 = t1.split('\n\n').filter(Boolean).map(e => { try { return JSON.parse(e.replace(/^data: /, '')) } catch { return null } }).filter(Boolean).find(e => e.type === 'done')
        console.log(`flash+RAG (${((Date.now() - t0) / 1000).toFixed(0)}s):`, (d1 && d1.answer || '').replace(/\s+/g, ' ').slice(0, 200))
    } catch (e) { console.log('flash 失败:', e.message) }
    // med-qa localrag
    try {
        const t0 = Date.now()
        const r2 = await fetch('http://localhost:3012/api/ask', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question, mode: 'localrag', regen: true }),
        })
        const b2 = await r2.json()
        console.log(`med-qa+RAG (${((Date.now() - t0) / 1000).toFixed(0)}s):`, (b2.answer || '').replace(/\s+/g, ' ').slice(0, 200))
    } catch (e) { console.log('med-qa 失败:', e.message) }
}

;(async () => {
    await test('质控问答', '入院记录患者基本信息有哪些质控要求？')
    await test('通识医学', '高血压的诊断标准是什么？')
    await test('质控判定', '一份入院记录现病史描述"患者三天前无明显诱因出现发热"，缺少时间补充说明，是否符合质控要求？')
    await test('深度治疗', '慢性阻塞性肺疾病急性加重期的治疗原则？')
    process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
