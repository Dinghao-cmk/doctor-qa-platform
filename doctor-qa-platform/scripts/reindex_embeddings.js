/**
 * reindex_embeddings.js - 用本地 Ollama bge-m3 重算全部启用段落的向量
 * 用法：node scripts/reindex_embeddings.js [--limit N]
 */
const { db } = require('../src/db')
const { generateEmbedding } = require('../src/services/embedding')

async function main() {
    const limitArg = process.argv.find(a => a.startsWith('--limit='))
    const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0

    const q = db('rag_passage').where('enabled', true).select('id', 'content').orderBy('id')
    if (limit) q.limit(limit)
    const rows = await q
    console.log('待重算段落数:', rows.length)

    // 先确认列维度
    const dimCheck = await db.raw('SELECT atttypmod FROM pg_attribute WHERE attrelid = \'data.rag_passage\'::regclass AND attname = \'embedding\'')
    console.log('embedding 列维度:', dimCheck.rows[0] ? ((dimCheck.rows[0].atttypmod - 4) / 4) : '未知')

    let ok = 0, fail = 0
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        const vec = await generateEmbedding(r.content)
        if (vec) {
            await db('rag_passage').where('id', r.id).update({ embedding: JSON.stringify(vec) })
            ok++
        } else {
            fail++
            console.log(`失败 #${r.id}: ${r.content.slice(0, 40)}`)
        }
        if ((i + 1) % 100 === 0) console.log(`进度: ${i + 1}/${rows.length} (ok=${ok} fail=${fail})`)
    }
    console.log(`完成: 成功 ${ok} / 失败 ${fail}`)
    process.exit(fail > 0 ? 1 : 0)
}

main().catch(e => { console.error('失败:', e.message); process.exit(1) })
