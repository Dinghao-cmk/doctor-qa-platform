/**
 * eval_compare.js - 基座模型 vs 微调模型对比评测
 * - 质控判定：rag_train_judge_v2.jsonl（若存在，否则 rag_train_judge.jsonl）104/74 条，比对"判定：正确/不正确"
 * - 知识问答：从 rag_train_v3.jsonl 抽 10 条，检查是否带 [参考N] 引用
 * - 泛化题：10 条两边都未见过的人工构造题
 * 输出：eval_compare_result.json（含逐条回答，供人工抽检）
 * 用法：node eval_compare.js [med|base|both]（默认 both）
 */
const fs = require('fs')
const path = require('path')

const HERE = __dirname
const API = 'http://localhost:11434/api/generate'
const MODELS = {
  base: 'qwen2.5:7b-instruct',      // 未微调基座
  med: 'qwen2.5-7b-med-r4',         // r=4（v3 数据，线上）
  med_v5: 'qwen2.5-7b-med-r4-v5',   // r=4（v5 数据，含判定样本）
}

const JUDGE_INSTRUCTION =
  '你是一位病历质控专家，负责复核病历质量缺陷的判定。针对每条"缺陷声称"，结合临床知识判断该声称是否成立：' +
  '若成立，说明支持该缺陷的充分理由；若不成立，指出其不准确或过于绝对之处，并给出正确的判断依据。' +
  '判定必须严谨、结合临床实际，不得仅凭片面信息下结论。'
const QA_INSTRUCTION =
  '你是一位专业的医学知识问答助手，服务于临床医生。回答必须严格基于提供的参考资料，每个要点标注 [参考N]，' +
  '不编造、不补充资料外的内容，不确定处如实说明。'

// 泛化题（两边都没训练过；答案明确）
const GENERALIZATION = [
  { claim: '患者性别记录为女性，但主诉及现病史描述为"前列腺增生"', verdict: '正确', reason: '性别与前列腺增生矛盾，属记录错误' },
  { claim: '患者年龄记录45岁，但身份证出生日期计算为21岁，两者矛盾', verdict: '正确', reason: '年龄信息前后矛盾' },
  { claim: '主诉"发热3天"，但体温单记录均在36.2-36.8℃之间，无发热处理记录', verdict: '不正确', reason: '主诉发热但本次体温正常可能为既往发热，不能仅凭主诉认定缺陷' },
  { claim: '患者为2型糖尿病多年，本次处方开具二甲双胍，病历无血糖监测记录', verdict: '正确', reason: '长期用药应记录监测，但主要缺陷是缺少血糖记录' },
  { claim: '病历诊断"急性阑尾炎"，但主诉为"咳嗽咳痰3天"，两者完全无关且无腹部症状描述', verdict: '正确', reason: '诊断与主诉完全脱节，缺乏支持依据' },
  { claim: '病历记录"双侧瞳孔等大等圆"，但护理记录单为"左侧瞳孔散大固定"，两份记录瞳孔状态矛盾', verdict: '正确', reason: '瞳孔状态是神经功能监测的关键指标，两份文书矛盾属明确缺陷' },
  { claim: '患者出院诊断"糖尿病酮症酸中毒"，但住院期间血糖记录最低为1.8mmol/L，且无任何低血糖处理记录', verdict: '正确', reason: 'DKA治疗中血糖1.8mmol/L属严重低血糖，无处理记录属明确缺陷' },
  { claim: '主诉"发热1天"，但体温单记录最高37.2℃，且无发热用药记录，发热未处理属缺陷', verdict: '不正确', reason: '37.2℃未达发热标准（≥37.3℃），不构成发热，声称不成立' },
  { claim: '医嘱静脉输注0.9%氯化钠500ml，但护理记录无尿量记录，无尿量记录即属缺陷', verdict: '不正确', reason: '并非所有输液患者必须记录尿量，是否需记录取决于病情（如心肾功能、出入量管理需求）' },
  { claim: '手术记录与术后首次病程记录时间均为2026-08-19 10:00，两者时间相同，属记录伪造', verdict: '不正确', reason: '术后首次病程记录可在术后即时完成，与手术结束时间相同属正常，不能认定伪造' },
]

let failCount = 0

async function callModel(model, prompt, maxTokens = 300) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { num_predict: maxTokens, temperature: 0.3 } }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.response.trim()
}

// 解析判定结果（兼容不同格式："判定：不正确" / "该说法不正确" / "不成立" 等）
function parseVerdict(text) {
  const m = text.match(/判定[:：]\s*(正确|不正确)/)
  if (m) return m[1]
  const n = text.match(/说法[:：]?\s*(正确|不正确)/)
  if (n) return n[1]
  // 兜底：按关键词判断（先查"不正确"，避免其包含"正确"子串）
  if (/不正确|不成立|不能认定|不能据此|过于绝对|依据不足|并不矛盾|不必然/.test(text)) return '不正确'
  if (/正确|成立/.test(text)) return '正确'
  return null
}

async function runJudge(model, samples) {
  const results = []
  for (const s of samples) {
    const prompt = `${JUDGE_INSTRUCTION}\n\n请复核以下病历质控缺陷声称是否成立，并给出判定理由：\n\n${s.claim}`
    let resp = ''
    try { resp = await callModel(model, prompt) } catch (e) { failCount++; resp = `[调用失败] ${e.message}` }
    const got = parseVerdict(resp)
    results.push({
      claim: s.claim.slice(0, 40) + (s.claim.length > 40 ? '…' : ''),
      expected: s.verdict,
      got,
      correct: got === s.verdict,
      resp: resp.slice(0, 150),
    })
    const mark = got === s.verdict ? '✓' : (got ? '✗' : '?')
    console.log(`  [${mark}] 期望=${s.verdict} 实际=${got || '未解析'} | ${s.claim.slice(0, 30)}…`)
  }
  return results
}

async function runQA(model, samples) {
  const results = []
  for (const s of samples) {
    const prompt = `${QA_INSTRUCTION}\n\n${s.input}`
    let resp = ''
    try { resp = await callModel(model, prompt, 250) } catch (e) { failCount++; resp = `[调用失败] ${e.message}` }
    const hasRef = /\[参考\d+\]/.test(resp)
    results.push({ question: s.question, hasRef, resp: resp.slice(0, 300) })
    console.log(`  [${hasRef ? '✓引用' : '✗无引用'}] ${s.question.slice(0, 25)}…`)
  }
  return results
}

function summarize(name, judgeResults, qaResults, genResults) {
  const jOk = judgeResults.filter(r => r.correct).length
  const genOk = genResults.filter(r => r.correct).length
  const refOk = qaResults.filter(r => r.hasRef).length
  console.log(`\n========== ${name} 汇总 ==========`)
  console.log(`质控判定: ${jOk}/${judgeResults.length} (${(jOk / judgeResults.length * 100).toFixed(1)}%)`)
  console.log(`泛化题:   ${genOk}/${genResults.length} (${(genOk / genResults.length * 100).toFixed(1)}%)`)
  console.log(`问答引用: ${refOk}/${qaResults.length} (${(refOk / qaResults.length * 100).toFixed(1)}%)`)
  return { judge: jOk / judgeResults.length, gen: genOk / genResults.length, ref: refOk / qaResults.length }
}

async function main() {
  // 评测集：优先 v2（104 条），否则旧版（74 条）
  const judgeFile = fs.existsSync(path.join(HERE, 'rag_train_judge_v2.jsonl'))
    ? 'rag_train_judge_v2.jsonl' : 'rag_train_judge.jsonl'
  const judgeSamples = fs.readFileSync(path.join(HERE, judgeFile), 'utf8')
    .split('\n').filter(l => l.trim()).map(l => {
      const s = JSON.parse(l)
      const claim = s.input.split('判定理由：\n\n')[1] || s.input
      const verdict = s.output.startsWith('判定：正确') ? '正确' : '不正确'
      return { claim, verdict }
    })
  console.log(`判定样本: ${judgeSamples.length} 条（正=${judgeSamples.filter(s => s.verdict === '正确').length}, 负=${judgeSamples.filter(s => s.verdict === '不正确').length}）`)

  // 加载问答样本（抽 10 条）
  const allQa = fs.readFileSync(path.join(HERE, 'rag_train_v3.jsonl'), 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
    .filter(s => s.instruction.includes('医学知识问答'))
  const qaSamples = allQa.slice(0, 10).map(s => ({ input: s.input, question: (s.input.split('## 问题\n')[1] || s.input).slice(0, 60) }))
  console.log(`问答样本: 抽 ${qaSamples.length} 条`)

  const out = { generatedAt: new Date().toISOString(), judgeFile, models: {}, failCount }

  // 选择评测模型：node eval_compare.js [med|base|both]（默认 both）
  const target = (process.argv[2] || 'both').toLowerCase()
  const targets = target === 'both' ? Object.entries(MODELS) : [[target, MODELS[target]]].filter(Boolean)
  if (!targets.length) { console.error('未知模型: ' + target); process.exit(1) }

  for (const [key, model] of targets) {
    console.log(`\n########## 评测 ${key} (${model}) ##########`)
    const t0 = Date.now()
    const j = await runJudge(model, judgeSamples)
    const g = await runJudge(model, GENERALIZATION)
    const q = await runQA(model, qaSamples)
    const s = summarize(model, j, q, g)
    out.models[key] = { model, judge: j, generalization: g, qa: q, summary: s, elapsedSec: Math.round((Date.now() - t0) / 1000) }
  }

  // 对比汇总
  console.log('\n========== 最终对比 ==========')
  for (const [key, v] of Object.entries(out.models)) {
    console.log(`${v.model}: 判定 ${(v.summary.judge * 100).toFixed(1)}% | 泛化 ${(v.summary.gen * 100).toFixed(1)}% | 引用 ${(v.summary.ref * 100).toFixed(1)}% | 耗时 ${v.elapsedSec}s`)
  }

  fs.writeFileSync(path.join(HERE, 'eval_compare_result.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log('\n结果已保存: finetune/eval_compare_result.json')
}

main().catch(e => { console.error('运行失败:', e); process.exit(1) })
