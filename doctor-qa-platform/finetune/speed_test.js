// speed_test.js - 测速：每个模型跑 2 条判定题，验证脚本逻辑和速度
const fs = require('fs')
const path = require('path')

const API = 'http://localhost:11434/api/generate'

async function callModel(model, prompt, maxTokens = 200) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: maxTokens, temperature: 0.3 } }),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return (await res.json()).response.trim()
}

const instruction =
  '你是一位病历质控专家，负责复核病历质量缺陷的判定。针对每条"缺陷声称"，结合临床知识判断该声称是否成立：' +
  '若成立，说明支持该缺陷的充分理由；若不成立，指出其不准确或过于绝对之处，并给出正确的判断依据。' +
  '判定必须严谨、结合临床实际，不得仅凭片面信息下结论。'

async function main() {
  const lines = fs.readFileSync(path.join(__dirname, 'rag_train_judge.jsonl'), 'utf8')
    .split('\n').filter(Boolean).slice(0, 2)
  const samples = lines.map(l => {
    const s = JSON.parse(l)
    return { claim: s.input.split('判定理由：\n\n')[1] || s.input, verdict: s.output.startsWith('判定：正确') ? '正确' : '不正确' }
  })
  for (const model of ['qwen2.5:7b-instruct', 'qwen2.5-7b-med']) {
    for (const s of samples) {
      const t0 = Date.now()
      const resp = await callModel(model, `${instruction}\n\n请复核以下病历质控缺陷声称是否成立，并给出判定理由：\n\n${s.claim}`)
      const m = resp.match(/判定[:：]\s*(正确|不正确)/)
      console.log(`${model} | ${Date.now() - t0}ms | ${m ? m[1] : '未解析'} | 期望 ${s.verdict} | ${s.claim.slice(0, 25)}…`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
