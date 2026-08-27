/**
 * convert_qc_rules.js - 真实质控规则入库
 * 读取 agent-qc-node 的 rules（290 个 yaml）+ rules_v2（类名映射）
 * → 生成结构化 markdown → ingestFromText 写入平台知识库
 * 用法：node scripts/convert_qc_rules.js
 */
const fs = require('fs')
const path = require('path')
const { ingestFromText } = require('../src/services/ingest')

const RULES_DIR = 'c:/在水医方/agent-qc-node-master/agent-qc-node/rules'
const V2_DIR = 'c:/在水医方/agent-qc-node-master/agent-qc-node/rules_v2'

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

/** 从 v2 文件名提取类名映射：A001 入院记录-一般情况内涵质控 */
function buildClassNames() {
    const map = {}
    if (!fs.existsSync(V2_DIR)) return map
    for (const f of fs.readdirSync(V2_DIR)) {
        if (!f.endsWith('.yaml')) continue
        const m = f.match(/^([A-Z]\d{3})\s+(.+?)\.yaml$/)
        if (m) map[m[1]] = m[2]
    }
    return map
}

async function main() {
    const files = fs.readdirSync(RULES_DIR).filter(f => f.endsWith('.yaml'))
    console.log('规则文件数:', files.length)

    // 解析全部规则
    const rules = []
    for (const f of files) {
        const txt = fs.readFileSync(path.join(RULES_DIR, f), 'utf8')
        const rule = parseRuleYaml(txt)
        const cls = f.split('.')[0] // A001
        if (!rule['质控CODE']) rule['质控CODE'] = f.split('.')[0] + '.' + f.split('.')[1]
        rules.push({ cls, file: f, ...rule })
    }
    const classNames = buildClassNames()
    console.log('v2 类名映射数:', Object.keys(classNames).length)

    // 按类分组生成 markdown
    const groups = {}
    for (const r of rules) (groups[r.cls] = groups[r.cls] || []).push(r)
    const lines = ['# 住院病历质控规则库（真实质控规则，共 ' + rules.length + ' 条）', '']
    for (const [cls, list] of Object.entries(groups)) {
        const name = classNames[cls] || '未命名类'
        lines.push(`## ${cls} ${name}（${list.length} 条）`, '')
        for (const r of list) {
            lines.push(`### ${r['质控CODE']} ${r['质控名称'] || ''}`, '')
            lines.push(`**质控CODE**：${r['质控CODE']}`)
            lines.push(`**质控名称**：${r['质控名称'] || ''}`)
            if (r['质控逻辑']) lines.push(`**质控逻辑**：${r['质控逻辑']}`)
            if (r['质控规则']) lines.push(`**质控规则**：`, '', r['质控规则'], '')
            if (r['额外信息']) lines.push(`**额外信息**：${r['额外信息']}`, '')
            lines.push('')
        }
    }
    const markdown = lines.join('\n')
    console.log('markdown 生成: ' + Math.round(markdown.length / 1024) + 'KB')

    // 入库（同名书籍已存在会自动禁用旧树）
    const result = await ingestFromText(markdown, '住院病历质控规则库.md', { domain: '质控' })
    console.log('入库完成:', JSON.stringify(result))
    process.exit(0)
}

main().catch(e => { console.error('失败:', e.message); process.exit(1) })
