#!/usr/bin/env node
/**
 * demo_rag_flow.js — RAG 质控复判全流程演示
 *
 * 用法:
 *   set RAG_DB_CONN_STR=postgres:rag123@localhost:5432/rag
 *   set RAG_SERVER_ROOT=http://localhost:8100
 *   node demo_rag_flow.js
 *
 * 前提:
 *   1. Docker PostgreSQL 容器 rag-pg 运行中
 *   2. Python RAG 服务已启动 (uvicorn main:app --port 8100)
 */

const { getPageRoute, pageIndexSearch, keywordSearch } = require('./node/config/ragPageIndex')
const { lightragSearch } = require('./node/config/ragGraph')
const agent = require('superagent')
const _ = require('lodash')

// ── 配置 ─────────────────────────────────────────────────────
const RAG_SERVER_ROOT = process.env.RAG_SERVER_ROOT || 'http://localhost:8100'

// ── 演示用例 ─────────────────────────────────────────────────
const DEMO_CASES = [
    {
        ruleCode: 'A004',
        defect: '社区获得性肺炎，病原学检查不充分',
        desc: 'PageIndex 静态路由 → 定向向量搜索',
    },
    {
        ruleCode: 'B001',
        defect: '肺部感染经验性用药，未参照抗菌药物分级管理',
        desc: 'PageIndex 路由 + LightRAG 图谱联动',
    },
]

// ── 工具函数 ─────────────────────────────────────────────────
const LINE = '═'.repeat(56)
const THIN = '─'.repeat(56)

function banner(text) {
    console.log('')
    console.log(LINE)
    console.log(`  ${text}`)
    console.log(LINE)
}

function step(num, title) {
    console.log('')
    console.log(`── Step ${num}: ${title} ${'─'.repeat(Math.max(0, 48 - title.length))}`)
}

function ok(text) {
    console.log(`  [OK] ${text}`)
}

function info(text) {
    console.log(`  ${text}`)
}

function warn(text) {
    console.log(`  [!!] ${text}`)
}

function getTxt(r) { return r.txt || r.content || JSON.stringify(r) }
function getSrc(r) { return r.source || r.note_qc_code || 'keyword' }
function truncate(str, len = 60) {
    if (!str) return ''
    return str.length > len ? str.slice(0, len) + '...' : str
}

// ── 扁平搜索（直接调 Python 服务）──────────────────────────
async function ragVerifySearch({ queryText, noteQcCode }) {
    try {
        const res = await agent
            .post(`${RAG_SERVER_ROOT}/rag_verify_search`)
            .send({ query_text: queryText, note_qc_code: noteQcCode, limit_count: 3 })
            .timeout({ response: 15000 })
        return res.body || []
    } catch (e) {
        return []
    }
}

// ── 主流程 ─────────────────────────────────────────────────
async function runDemo(demoCase) {
    const { ruleCode, defect, desc } = demoCase

    banner(`RAG 质控复判 — 全流程演示`)
    console.log('')
    info(`演示场景: ${desc}`)
    info(`质控编码: ${ruleCode}`)
    info(`缺陷描述: ${defect}`)

    let rag_res = null
    let searchSource = 'flat'

    // ── Step 1: PageIndex 静态路由 ──
    step(1, 'PageIndex 目录路由（零向量，纯 SQL 匹配）')
    const route = await getPageRoute(ruleCode)
    if (route) {
        ok(`Stage1 路由命中: ${route.docIds.length} 本书, ${route.passageIds.length} 个段落`)

        // 查书名
        try {
            const ragKnex = require('./node/config/ragKnexfile')
            const docs = await ragKnex('data.rag_source_doc')
                .whereIn('id', route.docIds)
                .select('id', 'title', 'doc_type', 'node_path')
            docs.forEach(d => info(`    -> [doc_id=${d.id}] ${d.title} (${d.doc_type}) ${d.node_path}`))
        } catch (e) { /* ignore */ }

        // ── Step 2: PageIndex 定向向量搜索 ──
        step(2, 'PageIndex 定向向量搜索（在限定段落中精检）')
        rag_res = await pageIndexSearch({
            queryText: defect,
            noteQcCode: ruleCode,
            docIds: route.docIds,
            passageIds: route.passageIds,
        })
        searchSource = 'pageindex'

        if (rag_res && !_.isEmpty(rag_res)) {
            ok(`向量搜索命中 ${rag_res.length} 条`)
            rag_res.forEach((r, i) => {
                info(`    [${i + 1}] [${getSrc(r)}] ${r.section_path || ''}`)
                info(`        "${truncate(getTxt(r), 70)}"  (sim=${(r.similarity || 0).toFixed(2)})`)
            })
        } else {
            warn('向量搜索无结果')

            // ── Step 2b: 关键词搜索补充 ──
            step('2b', '关键词搜索补充（ILIKE 模糊匹配）')
            rag_res = await keywordSearch(defect, route.docIds)
            if (rag_res && !_.isEmpty(rag_res)) {
                searchSource = 'pageindex→keyword'
                ok(`关键词搜索命中 ${rag_res.length} 条`)
                rag_res.forEach((r, i) => {
                    info(`    [${i + 1}] [${getSrc(r)}] ${r.section_path || ''}`)
                    info(`        "${truncate(getTxt(r), 70)}"`)
                })
            } else {
                warn('关键词搜索也无结果')

                // ── Step 3: LightRAG 图谱检索（PageIndex 联动）──
                step(3, 'LightRAG 知识图谱检索（PageIndex doc_ids 联动）')
                rag_res = await lightragSearch({
                    queryText: defect,
                    noteQcCode: ruleCode,
                    docIds: route.docIds,
                })
                if (rag_res && !_.isEmpty(rag_res)) {
                    searchSource = 'pageindex→lightrag'
                    ok(`LightRAG 命中 ${rag_res.length} 条`)
                    rag_res.forEach((r, i) => {
                        info(`    [${i + 1}] [${getSrc(r)}] ${r.section_path || ''}`)
                        info(`        "${truncate(getTxt(r), 70)}"`)
                    })
                } else {
                    warn('LightRAG 也无结果')

                    // ── Step 4: 扁平搜索兜底 ──
                    step(4, '扁平 ragVerifySearch 兜底')
                    rag_res = await ragVerifySearch({ queryText: defect, noteQcCode: ruleCode })
                    searchSource = 'pageindex→flat_fallback'
                    if (rag_res && !_.isEmpty(rag_res)) {
                        ok(`扁平搜索命中 ${rag_res.length} 条`)
                    } else {
                        warn('扁平搜索也无结果')
                    }
                }
            }
        }
    } else {
        warn(`Stage1 无路由映射 (ruleCode=${ruleCode})`)
        info('将走 LLM 动态推理或扁平搜索...')
    }

    // ── 结果汇总 ──
    step('N', '结果汇总')
    if (!rag_res || _.isEmpty(rag_res)) {
        info('检索结果为空 → 默认通过（不拦截）')
    } else {
        info(`检索路径: ${searchSource}`)
        info(`命中条数: ${rag_res.length}`)
        info('')
        info('构造引用文本（供 LLM 复判 Prompt）:')
        rag_res.forEach((item, idx) => {
            const src = getSrc(item)
            info(`  [${idx + 1}] [${src}] ${truncate(getTxt(item), 70)}`)
        })
        info('')
        info('→ 送入 LLM 复判: 比对缺陷描述 vs 知识引用 → 判定通过/拦截')
    }
}

// ── 入口 ─────────────────────────────────────────────────
async function main() {
    console.log('')
    console.log('  RAG 质控复判全流程演示脚本')
    console.log('  前提: Docker rag-pg 运行中 + Python RAG 服务已启动')
    console.log('')

    // 检查 Python 服务是否在线
    try {
        const health = await agent.get(`${RAG_SERVER_ROOT}/health`).timeout({ response: 5000 })
        ok(`RAG 服务在线: ${JSON.stringify(health.body)}`)
    } catch (e) {
        console.error('  [ERROR] RAG Python 服务未启动！请先执行:')
        console.error('    cd python/rag_service && python -m uvicorn main:app --port 8100')
        process.exit(1)
    }

    // 依次演示每个用例
    for (const demoCase of DEMO_CASES) {
        await runDemo(demoCase)
    }

    banner('演示完成')
    console.log('')
    info('以上展示了 RAG 复判的完整降级链:')
    info('  PageIndex 路由 → 向量搜索 → 关键词搜索 → LightRAG 图谱 → 扁平搜索')
    info('')
    info('每一步无结果时自动降级到下一级，确保知识召回率。')
    console.log('')
    process.exit(0)
}

main().catch(e => {
    console.error('演示异常:', e.message)
    process.exit(1)
})
