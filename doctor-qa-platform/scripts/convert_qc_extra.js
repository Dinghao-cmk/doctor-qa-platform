/**
 * convert_qc_extra.js - 质控系统剩余真实数据入库
 * 1. rules_v2 核查卡（35 个 yaml）→ 《住院病历质控核查卡》
 * 2. sql/000100_add_coding_rules.sql 编码规则 → 《医疗编码规则库》
 * 用法：node scripts/convert_qc_extra.js
 */
const fs = require('fs')
const path = require('path')
const { ingestFromText } = require('../src/services/ingest')

const V2_DIR = 'c:/在水医方/agent-qc-node-master/agent-qc-node/rules_v2'
const SQL_FILE = 'c:/在水医方/agent-qc-node-master/agent-qc-node/sql/000100_add_coding_rules.sql'

/** 解析自定义 yaml（字段名: 值，多行块用 |- 或 |） */
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
                    if (l.startsWith('  ') || l.startsWith('\t') || l.trim() === '') {
                        block.push(l.replace(/^ {2}/, ''))
                        i++
                    } else break
                }
                rule[key] = block.join('\n').trim()
            } else {
                rule[key] = val.trim()
                i++
            }
        } else i++
    }
    return rule
}

/** 生成核查卡 markdown */
function buildCardsMd() {
    const files = fs.readdirSync(V2_DIR).filter(f => f.endsWith('.yaml'))
    const lines = ['# 住院病历质控核查卡（真实核查要点，共 ' + files.length + ' 张）', '']
    for (const f of files) {
        const r = parseRuleYaml(fs.readFileSync(path.join(V2_DIR, f), 'utf8'))
        const name = f.replace(/\.yaml$/, '')
        lines.push(`## ${name}`, '')
        if (r['质控逻辑']) lines.push(`**质控逻辑**：${r['质控逻辑']}`, '')
        if (r['质控规则']) lines.push(`**质控规则**：`, '', r['质控规则'], '')
        if (r['质控CODE']) lines.push(`**质控CODE**：${r['质控CODE']}`, '')
        lines.push('')
    }
    return lines.join('\n')
}

/** 从 SQL INSERT 提取 (标题路径, 内容) 对 */
function extractSqlPassages(sql) {
    const pairs = []
    // 提取文档节点（标题）
    const nodeTitles = {}
    const nodeRe = /INSERT INTO data\.rag_source_doc \(([^)]*title[^)]*)\) VALUES\s*\n([\s\S]*?)ON CONFLICT/g
    let m
    while ((m = nodeRe.exec(sql)) !== null) {
        const rows = m[2]
        const rowRe = /\((\d+),\s*'([^']+)'/g
        let rm
        while ((rm = rowRe.exec(rows)) !== null) {
            nodeTitles[rm[1]] = rm[2].replace(/''/g, "'")
        }
    }
    // 提取段落
    const passRe = /INSERT INTO data\.rag_passage \(([^)]*section_path[^)]*)\) VALUES\s*\n([\s\S]*?)ON CONFLICT/g
    while ((m = passRe.exec(sql)) !== null) {
        const rows = m[2]
        const rowRe = /\((\d+),\s*'([^']*)',\s*'([\s\S]*?)'\)/g
        let rm
        while ((rm = rowRe.exec(rows)) !== null) {
            const docId = rm[1]
            const sectionPath = rm[2].replace(/''/g, "'")
            const content = rm[3].replace(/''/g, "'").replace(/\\n/g, '\n')
            const title = nodeTitles[docId] || sectionPath.split('/').filter(Boolean).pop() || '未命名'
            pairs.push({ title, sectionPath, content })
        }
    }
    return pairs
}

/** 生成编码规则 markdown */
function buildCodingMd() {
    const sql = fs.readFileSync(SQL_FILE, 'utf8')
    const pairs = extractSqlPassages(sql)
    const lines = ['# 医疗编码规则库（真实编码知识，' + pairs.length + ' 条）', '']
    for (const p of pairs) {
        lines.push(`## ${p.title}`, '')
        if (p.sectionPath && p.sectionPath !== p.title) lines.push(`**路径**：${p.sectionPath}`, '')
        lines.push(p.content, '', '')
    }
    return lines.join('\n')
}

async function main() {
    // 1. 核查卡
    const cardsMd = buildCardsMd()
    console.log('核查卡 markdown: ' + Math.round(cardsMd.length / 1024) + 'KB')
    const r1 = await ingestFromText(cardsMd, '住院病历质控核查卡.md', { domain: '质控' })
    console.log('核查卡入库:', JSON.stringify(r1))

    // 2. 编码规则
    const codingMd = buildCodingMd()
    console.log('编码规则 markdown: ' + Math.round(codingMd.length / 1024) + 'KB')
    const r2 = await ingestFromText(codingMd, '医疗编码规则库.md', { domain: '质控' })
    console.log('编码规则入库:', JSON.stringify(r2))
    process.exit(0)
}

main().catch(e => { console.error('失败:', e.message); process.exit(1) })
