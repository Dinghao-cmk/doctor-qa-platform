/**
 * scripts/init_badcase.js - 初始化 qa_badcase 表（幂等，可重复执行）
 *
 * 用法：node scripts/init_badcase.js
 * 表结构：检索弱命中样本池（学习闭环数据源），qa_feedback / rag_book_request_log 同 schema（data）
 */
const { db } = require('../src/db')

const SQL = `
CREATE TABLE IF NOT EXISTS data.qa_badcase (
    id SERIAL PRIMARY KEY,
    question TEXT NOT NULL,                        -- 用户问题
    reason TEXT NOT NULL,                          -- no_result | weak_hit | feedback_dislike
    answer TEXT,                                   -- 当时的回答（诊断用）
    sources TEXT,                                  -- 当时命中的来源书（| 分隔）
    model TEXT,                                    -- 当时的模型
    note TEXT,                                     -- 补充说明（如点踩原因）
    hit_count INTEGER NOT NULL DEFAULT 1,          -- 同问题同原因出现次数（自动累加）
    status TEXT NOT NULL DEFAULT 'pending',        -- pending=待标注 | reviewed=已处理 | fixed=已修复验证
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (question, reason)                      -- 幂等写入：重复出现累加 hit_count
);
CREATE INDEX IF NOT EXISTS idx_qa_badcase_status ON data.qa_badcase (status, hit_count DESC);
`

const main = async () => {
    try {
        await db.raw(SQL)
        console.log('✅ qa_badcase 表已就绪（幂等）')
    } catch (e) {
        console.error('❌ 建表失败:', e.message)
        process.exit(1)
    } finally {
        await db.destroy()
    }
}

main()
