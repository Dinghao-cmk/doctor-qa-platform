-- =======================================================================================
-- RAG 知识图谱层（GraphRAG）建表脚本
-- 目标数据库: rag 库 (psql -d rag)
-- 前置依赖: sql/rag_pageindex.sql（rag_source_doc / rag_passage 表须先存在）
-- 设计思想:
--   - rag_entity:       实体表（疾病/药物/症状/检查/手术等），GraphRAG 的节点
--   - rag_relationship: 关系表（实体间语义关联），GraphRAG 的边
--   - rag_community:    社区表（Leiden 聚类 + 多层摘要），GraphRAG 的宏观层
--   - rag_entity_passage: 实体-段落映射表，连接图谱与 PageIndex
-- 创建时间: 2026-07-08
-- =======================================================================================

BEGIN;

-- -------------------------------------------------------------------
-- 实体表 (rag_entity)
-- GraphRAG 的节点：疾病、药物、症状、检查、手术等医学实体
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data.rag_entity (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,                               -- "高血压" / "硝苯地平" / "头痛"
    entity_type VARCHAR(30) NOT NULL,                        -- disease | drug | symptom | exam | procedure | lab | ...
    aliases     TEXT[] DEFAULT '{}',                         -- 别名：["HTN", "hypertension", "高压"]
    summary     TEXT,                                        -- 实体摘要（GraphRAG 社区摘要的叶节点）
    embedding   VECTOR(1024),                                -- 实体名+摘要的向量（复用 generate_embedding()）
    source      VARCHAR(20) DEFAULT 'ai',                    -- 抽取来源：ai(LLM) | manual(人工) | dict(词典)
    enabled     BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_entity_name_type UNIQUE (name, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_rag_entity_type ON data.rag_entity (entity_type);
CREATE INDEX IF NOT EXISTS idx_rag_entity_enabled ON data.rag_entity (enabled);
CREATE INDEX IF NOT EXISTS idx_rag_entity_aliases ON data.rag_entity USING GIN (aliases);
-- 实体名模糊匹配索引（pg_trgm 需要 superuser 权限，暂不创建）
-- 当前实体匹配策略：aliases GIN 数组匹配 + embedding 向量相似度，已够用
-- CREATE INDEX IF NOT EXISTS idx_rag_entity_name_trgm ON data.rag_entity USING GIN (name gin_trgm_ops);

COMMENT ON TABLE data.rag_entity IS 'GraphRAG 实体表（图节点），存储疾病/药物/症状/检查/手术等医学实体';
COMMENT ON COLUMN data.rag_entity.entity_type IS '实体类型：disease(疾病) | drug(药物) | symptom(症状/主观) | finding(查体发现/客观) | exam(检查) | procedure(手术/操作) | lab(检验)';
COMMENT ON COLUMN data.rag_entity.aliases IS '实体别名数组，用于模糊匹配（如 HTN=hypertension=高血压）';
COMMENT ON COLUMN data.rag_entity.embedding IS '实体向量 vector(1024)，由触发器自动生成（与 rag_verify/rag_passage 同维度）';

-- 实体 embedding 自动生成触发器
CREATE OR REPLACE FUNCTION data.rag_entity_before_insert_or_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
  begin
    -- 拼接 name + summary 作为 embedding 输入文本（name 必选，summary 可选）
    new.embedding = generate_embedding(
        CASE
            WHEN new.summary IS NOT NULL AND new.summary != ''
                THEN new.name || '。' || new.summary
            ELSE new.name
        END
    );
    return new;
  end;
$function$;

CREATE TRIGGER rag_entity_before_insert_or_update_trigger
    BEFORE INSERT OR UPDATE ON data.rag_entity
    FOR EACH ROW EXECUTE FUNCTION data.rag_entity_before_insert_or_update();

-- -------------------------------------------------------------------
-- 关系表 (rag_relationship)
-- GraphRAG 的边：实体间的语义关联
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data.rag_relationship (
    id              SERIAL PRIMARY KEY,
    source_id       INT NOT NULL REFERENCES data.rag_entity(id) ON DELETE CASCADE,
    target_id       INT NOT NULL REFERENCES data.rag_entity(id) ON DELETE CASCADE,
    relation_type   VARCHAR(30),                             -- treats | contraindicated | causes | examines | complicates | ...
    description     TEXT,                                    -- 关系描述文本（LLM 生成）
    weight          FLOAT DEFAULT 1.0,                       -- 关系权重（1.0=默认，越高越重要）
    doc_id          INT REFERENCES data.rag_source_doc(id),  -- 关系来源文档（溯源用）
    enabled         BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_relationship UNIQUE (source_id, target_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_rag_rel_source ON data.rag_relationship (source_id);
CREATE INDEX IF NOT EXISTS idx_rag_rel_target ON data.rag_relationship (target_id);
CREATE INDEX IF NOT EXISTS idx_rag_rel_type ON data.rag_relationship (relation_type);
CREATE INDEX IF NOT EXISTS idx_rag_rel_enabled ON data.rag_relationship (enabled);

COMMENT ON TABLE data.rag_relationship IS 'GraphRAG 关系表（图的边），存储实体间语义关联';
COMMENT ON COLUMN data.rag_relationship.relation_type IS '关系类型：treats(治疗) | contraindicated(禁忌) | causes(导致) | examines(检查) | complicates(并发) | indicates(适应症)';

-- -------------------------------------------------------------------
-- 社区表 (rag_community)
-- GraphRAG 的多层级摘要：Leiden 聚类结果，支持 0~N 层粒度
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data.rag_community (
    id          SERIAL PRIMARY KEY,
    level       SMALLINT NOT NULL,                           -- 0=最细粒度, 1=中粒度, 2=粗粒度
    label       TEXT,                                        -- 社区名称（自动生成，如"心血管疾病-降压药"）
    summary     TEXT NOT NULL,                               -- 社区摘要（LLM 生成，GraphRAG global search 的核心）
    entity_ids  INT[] NOT NULL DEFAULT '{}',                 -- 包含的实体 ID 列表
    parent_id   INT REFERENCES data.rag_community(id),       -- 父社区（层级结构：细→中→粗）
    embedding   VECTOR(1024),                                -- 社区摘要向量
    enabled     BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_community_level ON data.rag_community (level);
CREATE INDEX IF NOT EXISTS idx_rag_community_parent ON data.rag_community (parent_id);
CREATE INDEX IF NOT EXISTS idx_rag_community_enabled ON data.rag_community (enabled);
CREATE INDEX IF NOT EXISTS idx_rag_community_entity_ids ON data.rag_community USING GIN (entity_ids);

COMMENT ON TABLE data.rag_community IS 'GraphRAG 社区表（Leiden 聚类），支持多层级摘要';
COMMENT ON COLUMN data.rag_community.level IS '社区层级：0=最细粒度（小社区）, 1=中粒度, 2=粗粒度（大社区）';
COMMENT ON COLUMN data.rag_community.summary IS '社区摘要（LLM 生成），用于 global search 的宏观上下文';

-- 社区 embedding 自动生成触发器
CREATE OR REPLACE FUNCTION data.rag_community_before_insert_or_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
  begin
    new.embedding = generate_embedding(
        CASE
            WHEN new.label IS NOT NULL AND new.label != ''
                THEN new.label || '。' || new.summary
            ELSE new.summary
        END
    );
    return new;
  end;
$function$;

CREATE TRIGGER rag_community_before_insert_or_update_trigger
    BEFORE INSERT OR UPDATE ON data.rag_community
    FOR EACH ROW EXECUTE FUNCTION data.rag_community_before_insert_or_update();

-- -------------------------------------------------------------------
-- 实体-段落映射表 (rag_entity_passage)
-- 连接图谱与 PageIndex：每个实体关联到哪些 passage
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data.rag_entity_passage (
    entity_id   INT NOT NULL REFERENCES data.rag_entity(id) ON DELETE CASCADE,
    passage_id  INT NOT NULL REFERENCES data.rag_passage(id) ON DELETE CASCADE,
    PRIMARY KEY (entity_id, passage_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_ep_entity ON data.rag_entity_passage (entity_id);
CREATE INDEX IF NOT EXISTS idx_rag_ep_passage ON data.rag_entity_passage (passage_id);

COMMENT ON TABLE data.rag_entity_passage IS 'GraphRAG 实体-段落映射表，连接知识图谱与 PageIndex';

-- 补充: pg_trgm 扩展（用于实体名模糊匹配索引）
-- 需要 superuser 权限，当前未安装。实体匹配暂用 aliases 数组 + embedding 向量替代
-- 后续如需启用，由 superuser 执行: CREATE EXTENSION pg_trgm WITH SCHEMA public;
-- 然后取消上方 gin_trgm_ops 索引的注释

-- -------------------------------------------------------------------
-- 增强: 可信度 + 反向溯源 + 规则-实体映射
-- -------------------------------------------------------------------

-- rag_entity 增加 confidence（AI抽取可信度）和 doc_id（来自哪本书，支持反向溯源）
ALTER TABLE data.rag_entity ADD COLUMN IF NOT EXISTS confidence FLOAT DEFAULT 1.0;
ALTER TABLE data.rag_entity ADD COLUMN IF NOT EXISTS doc_id INT REFERENCES data.rag_source_doc(id);
CREATE INDEX IF NOT EXISTS idx_rag_entity_doc_id ON data.rag_entity (doc_id);

COMMENT ON COLUMN data.rag_entity.confidence IS '可信度：1.0=人工确认, 0.8=AI高置信, 0.5=AI低置信';
COMMENT ON COLUMN data.rag_entity.doc_id IS '来源文档ID（反向溯源用），指向 rag_source_doc.id';

-- rag_relationship 增加 confidence
ALTER TABLE data.rag_relationship ADD COLUMN IF NOT EXISTS confidence FLOAT DEFAULT 1.0;
CREATE INDEX IF NOT EXISTS idx_rag_rel_doc_id ON data.rag_relationship (doc_id);

COMMENT ON COLUMN data.rag_relationship.confidence IS '可信度：1.0=人工确认, 0.8=AI高置信, 0.5=AI低置信';

-- -------------------------------------------------------------------
-- 规则-实体映射表 (rag_rule_entity_map)
-- 质控规则编码 → 相关实体，支持规则感知的图谱检索
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data.rag_rule_entity_map (
    id            SERIAL PRIMARY KEY,
    note_qc_code  TEXT NOT NULL,                             -- 质控编码（如 A010.001）
    entity_id     INT NOT NULL REFERENCES data.rag_entity(id) ON DELETE CASCADE,
    relevance     SMALLINT DEFAULT 1,                        -- 1=一般, 2=重要, 3=核心
    enabled       BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_rule_entity UNIQUE (note_qc_code, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_re_map_qc ON data.rag_rule_entity_map (note_qc_code);
CREATE INDEX IF NOT EXISTS idx_rag_re_map_entity ON data.rag_rule_entity_map (entity_id);

COMMENT ON TABLE data.rag_rule_entity_map IS 'GraphRAG 规则-实体映射表，支持规则感知的图谱子图检索';

COMMIT;
