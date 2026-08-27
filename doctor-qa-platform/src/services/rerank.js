/**
 * rerank.js - LLM 结果重排序服务
 * 在检索结果送入 LLM 生成回答前，先用 LLM 过滤与问题不相关的段落
 *
 * v2 变更：
 * - 三级相关度判断：2=直接相关、1=弱相关、0=无关，阈值 RERANK_MIN_LEVEL 可调
 * - 兼容旧 keep 数组格式
 * - 关键词兜底防误删：LLM 判无关但含 ≥2 个核心术语的段落自动恢复
 * - 效果：回答质量更高（不被无关内容干扰），token 消耗更少
 */
const debug = require('debug')
const superagent = require('superagent')
const config = require('../config')
const settings = require('./settings')
const { extractKeywords } = require('./search')

const log = debug('qa:rerank')

// 重排序最大候选数（超出则截断，避免 prompt 过长）
const MAX_CANDIDATES = 8

// 恢复判定：核心术语命中 ≥ 2 个的"无关"段落视为误删
const RESTORE_HIT_THRESHOLD = 2

/**
 * 用 LLM 判断哪些段落与问题相关（三级相关度）
 * @param {string} question - 用户提问
 * @param {Object[]} sources - 检索结果
 * @returns {Promise<Object[]>} 过滤后的结果（保持原顺序）
 */
const rerankResults = async (question, sources) => {
    if (!sources || sources.length === 0) return { kept: [], level2Count: null, details: [] }
    // 段落太少不需要重排（level2Count=null 表示无法判定，调用方回退回答后判定）
    if (sources.length <= 2) {
        log(`[rerank] 候选仅 ${sources.length} 条，跳过重排`)
        return { kept: sources, level2Count: null, details: null }
    }

    // 截断候选数，控制 prompt 长度
    const candidates = sources.slice(0, MAX_CANDIDATES)

    // 构建候选清单
    const candidateText = candidates
        .map((s, i) => {
            const book = s.bookTitle || s.docTitle || '未知来源'
            return `${i + 1}. [《${book}》] ${(s.content || '').slice(0, 150)}`
        })
        .join('\n')

    const prompt = `你是医学知识筛选助手。根据问题，对下列知识段落与问题的相关程度进行分级判断。

## 问题
${question}

## 候选段落
${candidateText}

## 分级标准
- level 2 = 直接相关：段落内容直接回答/支撑问题主题（含问题对应的医学实体，如疾病/药物/检查名）
- level 1 = 弱相关：与主题沾边但非直接相关（如仅泛泛提到，或提到相关但非核心的医学实体）
- level 0 = 无关：与问题无关（如问题问高血压，肺炎段落应判 0）

## 要求
- 输出 JSON：{"judgments": [{"id": 1, "level": 2}, {"id": 2, "level": 1}, ...]}
- 每个段落必须有一个判断
- 相关段落（level 2）按重要程度排序放在 judgments 前面
- 如果都不相关，全部 level 0
- 只输出 JSON，不要任何其他文字`

    const minLevel = config.rerank.minLevel // 默认 1：保留 直接相关+弱相关

    // 执行一次重排调用，返回 { levels, text }（失败返回 null）
    const runOnce = async () => {
        try {
            // 界面化配置优先（settings 表），env 兜底；重排序始终用快模型（便宜、延迟低）
            const { apiUrl, apiKey, model } = await settings.getLLM()
            const req = superagent
                .post(apiUrl)
                .send({
                    model,
                    messages: [
                        { role: 'system', content: '你是一个医学知识相关性筛选助手，只输出JSON。' },
                        { role: 'user', content: prompt },
                    ],
                    temperature: 0.1,
                    // reasoning 模型（flash）会先输出长推理过程，max_tokens 太小会把 content 截断成空（finish=length）
                    max_tokens: 2048,
                })
                .set('Content-Type', 'application/json')
                .timeout({ response: 30000 })

            if (apiKey) req.set('Authorization', `Bearer ${apiKey}`)
            const res = await req
            const msg = res.body?.choices?.[0]?.message || {}
            // 兼容 reasoning 模型：content 偶发为空时尝试 reasoning_content 提取 JSON
            const text = (msg.content || msg.reasoning_content || '').trim()
            if (!text) {
                log('[rerank] LLM 返回为空')
                return null
            }

            // 解析 JSON（容错处理：提取大括号内容）
            let parsed = null
            try {
                parsed = JSON.parse(text)
            } catch {
                const match = text.match(/\{[\s\S]*\}/)
                if (match) {
                    try { parsed = JSON.parse(match[0]) } catch { parsed = null }
                }
            }
            if (!parsed) {
                log(`[rerank] JSON 解析失败: ${text.slice(0, 100)}`)
                return null
            }
            return { parsed, text }
        } catch (error) {
            log(`[rerank] LLM 调用失败: ${error.message}`)
            return null
        }
    }

    // 执行 + 失败重试（flash 偶发空返回/截断，最多重试 2 次共 3 次调用，显著降低退化概率）
    let result = await runOnce()
    for (let attempt = 1; attempt < 3 && !result; attempt++) {
        log(`[rerank] 第 ${attempt} 次调用失败/返回无效，重试`)
        await new Promise(r => setTimeout(r, 800))
        result = await runOnce()
    }
    if (!result) {
        log('[rerank] 重试仍失败，保留全部候选（标记未评估供前端展示）')
        const details = candidates.map((c, i) => ({ index: i + 1, level: 2, kept: true, note: '未评估（LLM重排失败，全部保留）' }))
        return { kept: candidates, level2Count: null, details }
    }

    const { parsed } = result

        // 解析三级相关度（兼容旧 keep 数组格式）
        const levels = new Map() // id -> level，默认未判定视为 level 2（容错保留）
        if (Array.isArray(parsed.judgments)) {
            for (const j of parsed.judgments) {
                if (j && Number.isInteger(j.id) && j.id >= 1 && j.id <= candidates.length && [0, 1, 2].includes(j.level)) {
                    levels.set(j.id, j.level)
                }
            }
        } else if (Array.isArray(parsed.keep)) {
            // 旧格式兼容：keep 数组 → 全部视为 level 2
            for (const n of parsed.keep) {
                if (Number.isInteger(n) && n >= 1 && n <= candidates.length) levels.set(n, 2)
            }
            // 旧格式未提及的段落默认保留（原逻辑解析失败也保留全部，这里保持宽松）
            for (let i = 1; i <= candidates.length; i++) {
                if (!levels.has(i)) levels.set(i, 2)
            }
        }

        // 关键词兜底防误删：level 0 但含 ≥2 个核心术语的段落恢复为 level 1
        const kwMap = extractKeywords(question)
        const keywords = [...kwMap.keys()]
        if (keywords.length > 0) {
            candidates.forEach((c, i) => {
                const n = i + 1
                if ((levels.get(n) ?? 2) === 0) {
                    const content = c.content || ''
                    let hits = 0
                    for (const kw of keywords) {
                        if (content.includes(kw)) hits++
                    }
                    if (hits >= RESTORE_HIT_THRESHOLD) {
                        levels.set(n, 1)
                        log(`[rerank] 关键词兜底恢复 #${n}（命中${hits}个核心术语: ${keywords.filter(k => content.includes(k)).join('/')}）`)
                    }
                }
            })
        }

        // 过滤并保持原顺序
        const filtered = candidates.filter((_, i) => (levels.get(i + 1) ?? 2) >= minLevel)
        const levelCount = { 2: 0, 1: 0, 0: 0 }
        for (let i = 1; i <= candidates.length; i++) {
            const lv = levels.get(i) ?? 2
            levelCount[lv] = (levelCount[lv] || 0) + 1
        }
        log(`[rerank] ${candidates.length} 条 → 保留 ${filtered.length} 条 (minLevel=${minLevel}, 分布: ${JSON.stringify(levelCount)})`)
        // level2Count：LLM 判定“直接相关”的段落数（供弱命中判定；旧 keep 格式默认全部 level2）
        // details：逐条判定明细（前端展示重排过程，供演示/审计）
        const details = candidates.map((c, i) => {
            const lv = levels.get(i + 1) ?? 2
            return { index: i + 1, level: lv, kept: lv >= minLevel }
        })
        return { kept: filtered, level2Count: levelCount[2] || 0, details }
    }

module.exports = { rerankResults, MAX_CANDIDATES }
