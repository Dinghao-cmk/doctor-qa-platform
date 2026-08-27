/**
 * ingest_book.js — 新书一键入库脚本
 *
 * 用法:
 *   node scripts/ingest_book.js --file <书籍.txt> --title <书名> [--domain <领域>] [--qc-codes <A004,B001>]
 *
 * 流程:
 *   1. 读取文本文件，按段落切分
 *   2. 写入 rag_source_doc（目录树节点）
 *   3. 写入 rag_passage（段落 + 调用 Python 服务生成 embedding）
 *   4. 调用 LightRAG 插入接口（构建知识图谱）
 *   5. 若指定 --qc-codes，自动写入 rag_rule_doc_map 映射
 *
 * 环境变量:
 *   RAG_DB_CONN_STR  - RAG 数据库连接（必须）
 *   RAG_SERVER_ROOT  - Python RAG 服务地址（默认 http://127.0.0.1:8100/rpc）
 */

const fs = require('fs')
const path = require('path')
const agent = require('superagent')

// ── 参数解析 ──────────────────────────────────────────────────────
const args = process.argv.slice(2)
const getArg = (name) => {
    const idx = args.indexOf(`--${name}`)
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null
}

const filePath = getArg('file')
const bookTitle = getArg('title')
const domain = getArg('domain') || '医学'
const qcCodes = getArg('qc-codes') ? getArg('qc-codes').split(',').map((s) => s.trim()) : []

if (!filePath || !bookTitle) {
    console.error('用法: node scripts/ingest_book.js --file <书籍.txt> --title <书名> [--domain <领域>] [--qc-codes <A004,B001>]')
    process.exit(1)
}

const absFilePath = path.resolve(filePath)
if (!fs.existsSync(absFilePath)) {
    console.error(`文件不存在: ${absFilePath}`)
    process.exit(1)
}

// ── 配置 ──────────────────────────────────────────────────────────
const RAG_SERVER_ROOT = process.env.RAG_SERVER_ROOT || 'http://127.0.0.1:8100/rpc'
const EMBEDDING_URL = RAG_SERVER_ROOT + '/rag_pageindex_search' // 复用 Python 服务
const LIGHTRAG_INSERT_URL = RAG_SERVER_ROOT + '/rag_lightrag_insert'

// ── 数据库连接 ────────────────────────────────────────────────────
let ragKnex
try {
    ragKnex = require('../node/config/ragKnexfile')
} catch (e) {
    console.error('无法加载 ragKnexfile，请确保 RAG_DB_CONN_STR 环境变量已设置')
    process.exit(1)
}

// ── 文本切分 ──────────────────────────────────────────────────────
const CHUNK_SIZE = 500 // 每段最大字符数
const CHUNK_OVERLAP = 50 // 重叠字符数

function splitText(text) {
    // 先按自然段落分
    const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim().length > 20)
    const chunks = []

    for (const para of paragraphs) {
        if (para.length <= CHUNK_SIZE) {
            chunks.push(para.trim())
        } else {
            // 长段落按 CHUNK_SIZE 滑窗切分
            let start = 0
            while (start < para.length) {
                const end = Math.min(start + CHUNK_SIZE, para.length)
                chunks.push(para.slice(start, end).trim())
                start += CHUNK_SIZE - CHUNK_OVERLAP
            }
        }
    }
    return chunks
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
    console.log('═══════════════════════════════════════════')
    console.log(`  新书入库: ${bookTitle}`)
    console.log(`  文件: ${absFilePath}`)
    console.log(`  领域: ${domain}`)
    console.log(`  关联编码: ${qcCodes.length > 0 ? qcCodes.join(', ') : '(无)'}`)
    console.log('═══════════════════════════════════════════\n')

    // Step 1: 读取并切分
    console.log('[1/5] 读取文件并切分段落...')
    const rawText = fs.readFileSync(absFilePath, 'utf-8')
    const chunks = splitText(rawText)
    console.log(`  → 切分完成: ${chunks.length} 个段落 (原文 ${rawText.length} 字)\n`)

    if (chunks.length === 0) {
        console.error('切分结果为空，请检查文件内容')
        process.exit(1)
    }

    // Step 2: 写入 rag_source_doc
    console.log('[2/5] 创建目录树节点 (rag_source_doc)...')
    const [docRow] = await ragKnex('rag_source_doc')
        .insert({
            title: bookTitle,
            doc_type: 'book',
            domain: domain,
            node_path: `/${domain}/${bookTitle}`,
            enabled: true,
        })
        .returning('id')

    const docId = docRow?.id || docRow
    console.log(`  → doc_id = ${docId}\n`)

    // Step 3: 写入 rag_passage（批量）
    console.log('[3/5] 写入段落 (rag_passage)...')
    const BATCH_SIZE = 50
    let passageIds = []

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE)
        const rows = batch.map((content, idx) => ({
            doc_id: docId,
            content: content,
            section_path: `/${domain}/${bookTitle}/第${Math.floor(i / BATCH_SIZE) + 1}部分`,
            chunk_index: i + idx,
            enabled: true,
        }))

        const inserted = await ragKnex('rag_passage').insert(rows).returning('id')
        const ids = inserted.map((r) => r.id || r)
        passageIds.push(...ids)
        process.stdout.write(`  → 已写入 ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}\r`)
    }
    console.log(`\n  → 共写入 ${passageIds.length} 条段落\n`)

    // Step 4: 生成 embedding（调用 Python 服务）
    console.log('[4/5] 生成向量 (调用 Python RAG 服务)...')
    try {
        // 调用 Python 服务的批量 embedding 接口
        const embedUrl = RAG_SERVER_ROOT + '/rag_generate_embeddings'
        const resp = await agent
            .post(embedUrl)
            .send({ doc_id: docId })
            .timeout({ response: 300000, deadline: 600000 })

        console.log(`  → 向量生成完成: ${resp.body?.message || 'OK'}\n`)
    } catch (e) {
        console.log(`  ⚠ 向量生成接口不可用 (${e.message})`)
        console.log(`  → 可稍后手动执行: POST ${RAG_SERVER_ROOT}/rag_generate_embeddings {"doc_id": ${docId}}\n`)
    }

    // Step 4.5: LightRAG 索引
    console.log('[4.5/5] LightRAG 知识图谱索引...')
    try {
        const lightragResp = await agent
            .post(LIGHTRAG_INSERT_URL)
            .send({
                text: rawText.slice(0, 50000), // LightRAG 单次限制
                doc_id: docId,
                file_path: `${domain}/${bookTitle}`,
            })
            .timeout({ response: 300000, deadline: 600000 })

        console.log(`  → LightRAG 索引完成: ${lightragResp.body?.message || 'OK'}\n`)
    } catch (e) {
        console.log(`  ⚠ LightRAG 索引失败 (${e.message})`)
        console.log(`  → 可稍后手动调用: POST ${LIGHTRAG_INSERT_URL}\n`)
    }

    // Step 5: 写入 rag_rule_doc_map（如果指定了 qc-codes）
    if (qcCodes.length > 0) {
        console.log('[5/5] 写入编码映射 (rag_rule_doc_map)...')
        for (const code of qcCodes) {
            const exists = await ragKnex('rag_rule_doc_map')
                .where({ note_qc_code: code, doc_id: docId })
                .first()

            if (!exists) {
                await ragKnex('rag_rule_doc_map').insert({
                    note_qc_code: code,
                    doc_id: docId,
                    passage_ids: JSON.stringify(passageIds.slice(0, 20)), // 取前20个代表段落
                    relevance: 3,
                    source: 'ingest_script',
                    enabled: true,
                })
                console.log(`  → ${code} → doc_id=${docId} ✓`)
            } else {
                console.log(`  → ${code} → doc_id=${docId} (已存在，跳过)`)
            }
        }
        console.log('')
    } else {
        console.log('[5/5] 未指定 --qc-codes，跳过映射写入\n')
    }

    // ── 完成 ──
    console.log('═══════════════════════════════════════════')
    console.log('  ✅ 入库完成！')
    console.log(`  书名: ${bookTitle}`)
    console.log(`  doc_id: ${docId}`)
    console.log(`  段落数: ${passageIds.length}`)
    console.log(`  映射编码: ${qcCodes.length > 0 ? qcCodes.join(', ') : '无'}`)
    console.log('═══════════════════════════════════════════')

    await ragKnex.destroy()
}

main().catch((err) => {
    console.error('入库失败:', err.message)
    process.exit(1)
})
