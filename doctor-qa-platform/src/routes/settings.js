/**
 * routes/settings.js - 界面化 API 配置路由
 *
 * GET  /api/settings                读取当前配置（API Key 脱敏）
 * PUT  /api/settings                更新配置（空字符串 = 恢复默认）
 * POST /api/settings/test           测试连接（type: 'llm' | 'embedding'）
 * POST /api/settings/embedding/rebuild  为知识库段落回填 embedding（启用向量搜索前置步骤）
 */
const express = require('express')
const debug = require('debug')
const superagent = require('superagent')
const settings = require('../services/settings')
const { resetEmbeddingState } = require('../services/embedding')
const { runEmbeddingJob } = require('../services/embeddingJob')
const { db } = require('../db')

const log = debug('qa:settings-route')
const router = express.Router()

// ── GET /api/settings ─────────────────────────────────────
router.get('/settings', async (req, res) => {
    try {
        res.json({ ok: true, data: await settings.getPublic() })
    } catch (error) {
        log(`GET /settings 错误: ${error.message}`)
        res.status(500).json({ ok: false, error: error.message })
    }
})

// ── PUT /api/settings ─────────────────────────────────────
router.put('/settings', async (req, res) => {
    try {
        const body = req.body || {}
        // key 映射：界面字段 → 数据库 key
        const keyMap = {
            llmApiUrl: 'llm_api_url',
            llmApiKey: 'llm_api_key',
            llmModel: 'llm_model',
            llmStrongModel: 'llm_strong_model',
            llmFallback: 'llm_fallback',
            embeddingApiUrl: 'embedding_api_url',
            embeddingApiKey: 'embedding_api_key',
            embeddingModel: 'embedding_model',
            webSearchEnabled: 'web_search_enabled',
            webSearchApiKey: 'web_search_api_key',
            webSearchApiUrl: 'web_search_api_url',
            webSearchDomains: 'web_search_domains',
            webSearchThreshold: 'web_search_threshold',
            localLlmApiUrl: 'llm_local_api_url',
            localLlmApiKey: 'llm_local_api_key',
            localLlmModel: 'llm_local_model',
        }
        for (const [field, key] of Object.entries(keyMap)) {
            if (body[field] !== undefined && body[field] !== null) {
                await settings.set(key, body[field])
            }
        }
        // 配置可能影响 embedding 能力探测结果，重置标记让新配置立即生效
        resetEmbeddingState()
        log(`配置已更新: ${Object.keys(body).join(', ')}`)
        res.json({ ok: true, data: await settings.getPublic() })
    } catch (error) {
        log(`PUT /settings 错误: ${error.message}`)
        res.status(500).json({ ok: false, error: error.message })
    }
})

// ── POST /api/settings/test ───────────────────────────────
router.post('/settings/test', async (req, res) => {
    const { type = 'llm' } = req.body || {}
    try {
        if (type === 'llm') {
            const { apiUrl, apiKey, model } = await settings.getLLM()
            if (!apiUrl) return res.json({ ok: false, error: '未配置 LLM API 地址' })
            const r = await superagent
                .post(apiUrl)
                .send({ model, messages: [{ role: 'user', content: 'ping' }], temperature: 0, max_tokens: 5 })
                .set('Content-Type', 'application/json')
                .timeout({ response: 15000 })
                .set(...(apiKey ? ['Authorization', `Bearer ${apiKey}`] : []))
            const reply = r.body?.choices?.[0]?.message?.content || ''
            res.json({ ok: true, message: `LLM 连接正常，模型 ${model} 响应: ${reply.slice(0, 50)}` })
        } else if (type === 'embedding') {
            const { apiUrl, apiKey, model, enabled } = await settings.getEmbedding()
            if (!enabled) return res.json({ ok: false, error: '未配置 Embedding API 地址' })
            const r = await superagent
                .post(apiUrl)
                .send({ model, input: '测试', encoding_format: 'float' })
                .set('Content-Type', 'application/json')
                .timeout({ response: 15000 })
                .set(...(apiKey ? ['Authorization', `Bearer ${apiKey}`] : []))
            const dim = r.body?.data?.[0]?.embedding?.length
            res.json({ ok: true, message: `Embedding 连接正常，模型 ${model}，维度 ${dim}` })
        } else if (type === 'web') {
            const { apiUrl, apiKey, domains, enabled } = await settings.getWebSearch()
            if (!enabled) return res.json({ ok: false, error: '未配置联网搜索 API Key，请先在设置中填写' })
            const r = await superagent
                .post(apiUrl)
                .set('X-API-KEY', apiKey)
                .send({ q: '高血压诊断标准', num: 3, gl: 'cn', hl: 'zh-cn' })
                .timeout({ response: 15000 })
            const n = (r.body?.organic || []).length
            res.json({ ok: true, message: `联网搜索连接正常，返回 ${n} 条结果${domains.length ? `（域名限定: ${domains.join(', ')}）` : ''}` })
        } else if (type === 'local') {
            const { apiUrl, apiKey, model } = await settings.getLocalLLM()
            if (!apiUrl) return res.json({ ok: false, error: '未配置本地模型 API 地址' })
            const r = await superagent
                .post(apiUrl)
                .send({ model, messages: [{ role: 'user', content: 'ping' }], temperature: 0, max_tokens: 5 })
                .set('Content-Type', 'application/json')
                .timeout({ response: 20000 })
                .set(...(apiKey ? ['Authorization', `Bearer ${apiKey}`] : []))
            const reply = r.body?.choices?.[0]?.message?.content || ''
            res.json({ ok: true, message: `本地模型连接正常，模型 ${model} 响应: ${reply.slice(0, 50)}` })
        } else {
            res.json({ ok: false, error: `未知类型: ${type}` })
        }
    } catch (error) {
        res.json({ ok: false, error: `连接失败: ${error.message}` })
    }
})

// ── POST /api/settings/embedding/rebuild ──────────────────
// 为无向量的启用段落生成 embedding（增量、幂等）；并发 4 + 限流重试
router.post('/settings/embedding/rebuild', async (req, res) => {
    try {
        const { enabled } = await settings.getEmbedding()
        if (!enabled) return res.json({ ok: false, error: '未配置 Embedding API，无法生成向量' })

        const r = await runEmbeddingJob({ concurrency: 4 })
        const speed = r.durationMs > 0 ? (r.total / (r.durationMs / 1000)).toFixed(1) : 0
        res.json({
            ok: true,
            message: `向量生成完成：成功 ${r.ok}，失败 ${r.failed}，跳过 ${r.skipped}（共 ${r.total} 条，耗时 ${(r.durationMs / 1000).toFixed(1)}s，${speed} 条/秒）`,
            ...r,
        })
    } catch (error) {
        log(`embedding/rebuild 错误: ${error.message}`)
        res.status(500).json({ ok: false, error: error.message })
    }
})

module.exports = router
