-- ============================================================================
-- 迁移：rag_verify 增加 enabled 列（知识启用开关）
-- 背景：rag 知识参与检索（检出 / 去重）需要启用开关。
-- 策略（20260612 更新）：新增知识默认启用，后续由人工审核决定是否弃用（置 false）。
-- 检索过滤逻辑见 db/functions/rag_verify_search.sql（WHERE ... AND r.enabled = true）。
-- ============================================================================

# 在rag库中执行 psql -d rag
-- 1) 新增列：默认 true，所有新增知识（人工 / AI）天然启用
ALTER TABLE data.rag_verify
    ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

-- 2) 存量数据：全部保持启用，无需回填。
-- 如此前曾停用过 AI 知识，可执行以下语句恢复启用：
-- UPDATE data.rag_verify SET enabled = true WHERE enabled = false;
