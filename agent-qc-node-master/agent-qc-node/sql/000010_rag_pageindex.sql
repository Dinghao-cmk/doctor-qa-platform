-- =======================================================================================
-- RAG 分层目录索引（PageIndex）建表脚本
-- 目标数据库: rag 库 (psql -d rag)
-- 设计思想: 三层目录树（来源文档 → 段落），配合规则-文档映射表实现三阶段检索
--           Stage1 目录路由（零向量） → Stage2 定向检索（范围内向量精检）
-- 创建时间: 2026-07-08
-- =======================================================================================

BEGIN;

-- -------------------------------------------------------------------
-- Level 0: 来源文档表 (rag_source_doc)
-- 统一入口：一本书 / 一份指南 / 一个规范 / 或"系统萃取"（无原始文档）
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data.rag_source_doc (
    id            SERIAL PRIMARY KEY,
    title         TEXT NOT NULL,                           -- 《内科学·第10版》/ 《高血压基层诊疗指南2024》/ "系统萃取知识"
    doc_type      VARCHAR(20) NOT NULL,                    -- 'textbook' | 'guideline' | 'policy' | 'extracted'
    domain        VARCHAR(50),                             -- 领域分类：内科/外科/中医/药学/护理/感染/急救...
    keywords      TEXT[] DEFAULT '{}',                     -- 关键词标签（用于 Stage1 降级匹配）
    summary       TEXT,                                    -- 文档摘要（~200字）
    file_path     TEXT,                                    -- 原始文件路径（可选，便于溯源）
    enabled       BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_source_doc_domain ON data.rag_source_doc (domain);
CREATE INDEX IF NOT EXISTS idx_rag_source_doc_enabled ON data.rag_source_doc (enabled);
CREATE INDEX IF NOT EXISTS idx_rag_source_doc_keywords ON data.rag_source_doc USING GIN (keywords);

COMMENT ON TABLE data.rag_source_doc IS 'RAG分层索引-来源文档表（Level 0），统一存储书/指南/规范/萃取知识';
COMMENT ON COLUMN data.rag_source_doc.doc_type IS '文档类型：textbook(教材) | guideline(指南/共识) | policy(院内规范) | extracted(系统萃取)';

-- -------------------------------------------------------------------
-- Level 1: 段落/条款表 (rag_passage)
-- 最小检索单元，直接送入 LLM prompt 的知识单元
-- 含 embedding vector(1024)，与 rag_verify 同维度，由触发器自动生成
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data.rag_passage (
    id            SERIAL PRIMARY KEY,
    doc_id        INT NOT NULL REFERENCES data.rag_source_doc(id) ON DELETE CASCADE,
    section_path  TEXT,                                    -- "第3章 > §3.2 高血压" / "推荐意见 3.1" / null（经验短句）
    page_no       INT,                                     -- 页码（有的话）
    content       TEXT NOT NULL,                           -- 段落全文（送入 LLM 的内容）
    embedding     VECTOR(1024),                            -- 段落向量，由触发器自动生成（与 rag_verify 同维度）
    content_hash  VARCHAR(32),                             -- 内容 MD5，用于去重
    enabled       BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_passage_doc_id ON data.rag_passage (doc_id);
CREATE INDEX IF NOT EXISTS idx_rag_passage_enabled ON data.rag_passage (enabled);

COMMENT ON TABLE data.rag_passage IS 'RAG分层索引-段落表（Level 1），最小检索单元';
COMMENT ON COLUMN data.rag_passage.embedding IS '段落向量 vector(1024)，由 rag_passage_embedding_trigger 自动生成';

-- 段落 embedding 自动生成触发器
-- 复用 rag 库中已有的 generate_embedding() 函数（与 rag_verify 相同的 embedding 生成逻辑）
-- 区别：rag_verify 对 new.txt 生成，rag_passage 对 new.content 生成
CREATE OR REPLACE FUNCTION data.rag_passage_before_insert_or_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
  begin
    -- 调用 generate_embedding 函数生成 embedding（复用 rag_verify 相同的底层函数）
    new.embedding = generate_embedding(new.content);
    return new;
  end;
$function$;

CREATE TRIGGER rag_passage_before_insert_or_update_trigger
    BEFORE INSERT OR UPDATE ON data.rag_passage
    FOR EACH ROW EXECUTE FUNCTION data.rag_passage_before_insert_or_update();

-- -------------------------------------------------------------------
-- 规则-文档映射表 (rag_rule_doc_map)
-- Stage 1 核心路由表：note_qc_code → doc_id / passage_ids
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data.rag_rule_doc_map (
    id            SERIAL PRIMARY KEY,
    note_qc_code  TEXT NOT NULL,                           -- 质控编码（如 A010.001，对应 emr_eval_item.codev2）
    doc_id        INT NOT NULL REFERENCES data.rag_source_doc(id) ON DELETE CASCADE,
    passage_ids   INT[] DEFAULT '{}',                      -- 精确到段落 ID（空=整份文档都相关）
    relevance     SMALLINT DEFAULT 1,                      -- 相关度权重（1=一般, 2=重要, 3=核心）
    source        VARCHAR(20) DEFAULT 'manual',            -- 映射来源：manual(人工) | ai(LLM自动标注)
    enabled       BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_rag_rule_doc UNIQUE (note_qc_code, doc_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_rule_doc_map_qc_code ON data.rag_rule_doc_map (note_qc_code);
CREATE INDEX IF NOT EXISTS idx_rag_rule_doc_map_doc_id ON data.rag_rule_doc_map (doc_id);
CREATE INDEX IF NOT EXISTS idx_rag_rule_doc_map_enabled ON data.rag_rule_doc_map (enabled);

COMMENT ON TABLE data.rag_rule_doc_map IS 'RAG规则-文档映射表（Stage 1 路由核心）';
COMMENT ON COLUMN data.rag_rule_doc_map.note_qc_code IS '质控编码，与 rag_verify.note_qc_code / emr_eval_item.codev2 对应';
COMMENT ON COLUMN data.rag_rule_doc_map.passage_ids IS '关联段落ID数组，空数组表示整份文档都相关';

-- -------------------------------------------------------------------
-- 为现有 rag_verify 表补充 doc_id 外键（可选，建立短句与文档的关联）
-- -------------------------------------------------------------------
ALTER TABLE data.rag_verify ADD COLUMN IF NOT EXISTS doc_id INT REFERENCES data.rag_source_doc(id);
ALTER TABLE data.rag_verify ADD COLUMN IF NOT EXISTS passage_id INT REFERENCES data.rag_passage(id);

COMMENT ON COLUMN data.rag_verify.doc_id IS '关联文档ID（可选），指向 rag_source_doc.id';
COMMENT ON COLUMN data.rag_verify.passage_id IS '关联段落ID（可选），指向 rag_passage.id';

COMMIT;
