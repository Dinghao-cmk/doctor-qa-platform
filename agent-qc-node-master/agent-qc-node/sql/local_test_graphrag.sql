-- =======================================================================================
-- GraphRAG 测试数据灌入脚本（本地 Docker 环境）
-- 用法: docker cp 进容器后 docker exec -i rag-pg psql -U postgres -d rag -f /tmp/graph.sql
-- =======================================================================================

BEGIN;

-- -------------------------------------------------------------------
-- 1. 灌入实体（rag_entity）
-- 模拟医学质控常见实体：症状、检查、诊断、治疗、药物等
-- -------------------------------------------------------------------
INSERT INTO data.rag_entity (name, entity_type, description, doc_id, confidence)
VALUES
    -- 诊断检查类实体
    ('白细胞计数', 'lab_test', '血常规中的白细胞计数，正常值4-10×10^9/L', 5, 0.95),
    ('中性粒细胞', 'lab_test', '白细胞分类中的中性粒细胞比例', 5, 0.93),
    ('C反应蛋白', 'lab_test', '炎症标志物，CRP正常值<10mg/L', 5, 0.90),
    ('血培养', 'lab_test', '细菌感染的确诊检查', 5, 0.88),
    ('胸部CT', 'imaging', '胸部影像学检查，用于肺部疾病诊断', 5, 0.92),
    ('心电图', 'imaging', '心脏电生理检查', 5, 0.90),
    ('超声心动图', 'imaging', '心脏结构和功能评估', 5, 0.89),
    
    -- 症状/体征类实体
    ('发热', 'symptom', '体温>37.3°C，常见感染表现', 5, 0.95),
    ('咳嗽', 'symptom', '呼吸道症状，可见于多种疾病', 5, 0.93),
    ('胸痛', 'symptom', '胸部疼痛，需鉴别心肺疾病', 5, 0.91),
    ('呼吸困难', 'symptom', '气促、喘息，心肺功能不全表现', 5, 0.90),
    ('腹痛', 'symptom', '腹部疼痛，需鉴别急腹症', 6, 0.92),
    ('高血压', 'finding', '收缩压≥140mmHg或舒张压≥90mmHg', 6, 0.95),
    ('低血压', 'finding', '收缩压<90mmHg', 6, 0.90),
    
    -- 诊断类实体
    ('肺炎', 'diagnosis', '肺部感染性疾病', 5, 0.95),
    ('冠心病', 'diagnosis', '冠状动脉粥样硬化性心脏病', 6, 0.93),
    ('高血压病', 'diagnosis', '原发性高血压', 6, 0.95),
    ('糖尿病', 'diagnosis', '2型糖尿病最常见', 6, 0.94),
    ('阑尾炎', 'diagnosis', '急性阑尾炎，外科急腹症', 7, 0.90),
    
    -- 治疗/药物类实体
    ('青霉素', 'drug', 'β-内酰胺类抗生素', 6, 0.92),
    ('头孢菌素', 'drug', '广谱抗生素', 6, 0.90),
    ('阿司匹林', 'drug', '抗血小板聚集药物', 6, 0.93),
    ('降压药', 'drug', '包括ACEI/ARB/CCB等', 6, 0.91),
    ('胰岛素', 'drug', '糖尿病治疗药物', 6, 0.92),
    ('手术', 'treatment', '外科手术治疗', 7, 0.88),
    ('抗生素', 'drug', '抗感染治疗药物总称', 5, 0.94),
    
    -- 科室/流程类实体
    ('急诊科', 'department', '急诊诊疗科室', 7, 0.85),
    ('ICU', 'department', '重症监护室', 7, 0.87),
    ('入院记录', 'document', '患者入院时书写的首次病程记录', 7, 0.90),
    ('出院小结', 'document', '患者出院时的总结文档', 7, 0.89),
    ('手术记录', 'document', '手术过程的详细记录', 7, 0.88);

-- -------------------------------------------------------------------
-- 2. 灌入关系（rag_relationship）
-- 模拟实体间的医学关联关系
-- -------------------------------------------------------------------
-- 症状 → 诊断
INSERT INTO data.rag_relationship (source_id, target_id, relation_type, description, confidence)
VALUES
    ((SELECT id FROM data.rag_entity WHERE name='发热'), (SELECT id FROM data.rag_entity WHERE name='肺炎'), 'indicates', '发热是肺炎的常见症状', 0.85),
    ((SELECT id FROM data.rag_entity WHERE name='咳嗽'), (SELECT id FROM data.rag_entity WHERE name='肺炎'), 'indicates', '咳嗽是肺炎的常见症状', 0.88),
    ((SELECT id FROM data.rag_entity WHERE name='胸痛'), (SELECT id FROM data.rag_entity WHERE name='冠心病'), 'indicates', '胸痛是冠心病的典型表现', 0.90),
    ((SELECT id FROM data.rag_entity WHERE name='呼吸困难'), (SELECT id FROM data.rag_entity WHERE name='冠心病'), 'indicates', '呼吸困难可见于冠心病', 0.82),
    ((SELECT id FROM data.rag_entity WHERE name='腹痛'), (SELECT id FROM data.rag_entity WHERE name='阑尾炎'), 'indicates', '腹痛是阑尾炎的主要症状', 0.92);

-- 检查 → 诊断
INSERT INTO data.rag_relationship (source_id, target_id, relation_type, description, confidence)
VALUES
    ((SELECT id FROM data.rag_entity WHERE name='白细胞计数'), (SELECT id FROM data.rag_entity WHERE name='肺炎'), 'supports_diagnosis', '白细胞升高支持肺炎诊断', 0.87),
    ((SELECT id FROM data.rag_entity WHERE name='中性粒细胞'), (SELECT id FROM data.rag_entity WHERE name='肺炎'), 'supports_diagnosis', '中性粒细胞升高提示细菌感染', 0.85),
    ((SELECT id FROM data.rag_entity WHERE name='C反应蛋白'), (SELECT id FROM data.rag_entity WHERE name='肺炎'), 'supports_diagnosis', 'CRP升高提示炎症', 0.83),
    ((SELECT id FROM data.rag_entity WHERE name='胸部CT'), (SELECT id FROM data.rag_entity WHERE name='肺炎'), 'confirms_diagnosis', '胸部CT可确诊肺炎', 0.95),
    ((SELECT id FROM data.rag_entity WHERE name='心电图'), (SELECT id FROM data.rag_entity WHERE name='冠心病'), 'supports_diagnosis', '心电图异常支持冠心病诊断', 0.88),
    ((SELECT id FROM data.rag_entity WHERE name='血培养'), (SELECT id FROM data.rag_entity WHERE name='肺炎'), 'confirms_diagnosis', '血培养可确诊病原菌', 0.90);

-- 诊断 → 治疗
INSERT INTO data.rag_relationship (source_id, target_id, relation_type, description, confidence)
VALUES
    ((SELECT id FROM data.rag_entity WHERE name='肺炎'), (SELECT id FROM data.rag_entity WHERE name='抗生素'), 'treated_by', '肺炎需抗生素治疗', 0.95),
    ((SELECT id FROM data.rag_entity WHERE name='肺炎'), (SELECT id FROM data.rag_entity WHERE name='青霉素'), 'treated_by', '青霉素是肺炎常用抗生素', 0.88),
    ((SELECT id FROM data.rag_entity WHERE name='肺炎'), (SELECT id FROM data.rag_entity WHERE name='头孢菌素'), 'treated_by', '头孢菌素可用于肺炎治疗', 0.86),
    ((SELECT id FROM data.rag_entity WHERE name='冠心病'), (SELECT id FROM data.rag_entity WHERE name='阿司匹林'), 'treated_by', '阿司匹林抗血小板治疗', 0.92),
    ((SELECT id FROM data.rag_entity WHERE name='高血压病'), (SELECT id FROM data.rag_entity WHERE name='降压药'), 'treated_by', '高血压需降压治疗', 0.95),
    ((SELECT id FROM data.rag_entity WHERE name='糖尿病'), (SELECT id FROM data.rag_entity WHERE name='胰岛素'), 'treated_by', '糖尿病可用胰岛素治疗', 0.90),
    ((SELECT id FROM data.rag_entity WHERE name='阑尾炎'), (SELECT id FROM data.rag_entity WHERE name='手术'), 'treated_by', '阑尾炎通常需手术切除', 0.93);

-- 实体间其他关系
INSERT INTO data.rag_relationship (source_id, target_id, relation_type, description, confidence)
VALUES
    ((SELECT id FROM data.rag_entity WHERE name='发热'), (SELECT id FROM data.rag_entity WHERE name='白细胞计数'), 'accompanied_by', '发热常伴白细胞升高', 0.80),
    ((SELECT id FROM data.rag_entity WHERE name='高血压'), (SELECT id FROM data.rag_entity WHERE name='冠心病'), 'risk_factor_for', '高血压是冠心病的危险因素', 0.90),
    ((SELECT id FROM data.rag_entity WHERE name='糖尿病'), (SELECT id FROM data.rag_entity WHERE name='冠心病'), 'risk_factor_for', '糖尿病是冠心病的危险因素', 0.88);

-- -------------------------------------------------------------------
-- 3. 灌入实体-段落关联（rag_entity_passage）
-- 将实体关联到对应的段落
-- -------------------------------------------------------------------
INSERT INTO data.rag_entity_passage (entity_id, passage_id)
SELECT e.id, p.id
FROM data.rag_entity e
CROSS JOIN data.rag_passage p
WHERE p.doc_id = e.doc_id
LIMIT 30;

-- -------------------------------------------------------------------
-- 4. 灌入规则-实体映射（rag_rule_entity_map）
-- -------------------------------------------------------------------
INSERT INTO data.rag_rule_entity_map (note_qc_code, entity_id)
SELECT DISTINCT rm.note_qc_code, e.id
FROM data.rag_rule_doc_map rm
JOIN data.rag_entity e ON e.doc_id IN (
    SELECT passage_ids[1] FROM data.rag_rule_doc_map WHERE note_qc_code = rm.note_qc_code
)
LIMIT 20;

-- 如果上面没插进去，用更简单的方式
INSERT INTO data.rag_rule_entity_map (note_qc_code, entity_id)
SELECT 'A004.001', id FROM data.rag_entity WHERE entity_type = 'lab_test' LIMIT 3
ON CONFLICT DO NOTHING;

INSERT INTO data.rag_rule_entity_map (note_qc_code, entity_id)
SELECT 'B001.001', id FROM data.rag_entity WHERE entity_type = 'drug' LIMIT 3
ON CONFLICT DO NOTHING;

INSERT INTO data.rag_rule_entity_map (note_qc_code, entity_id)
SELECT 'J001.001', id FROM data.rag_entity WHERE entity_type = 'document' LIMIT 3
ON CONFLICT DO NOTHING;

COMMIT;

-- -------------------------------------------------------------------
-- 验证
-- -------------------------------------------------------------------
SELECT '=== GraphRAG 数据验证 ===' as status;
SELECT 'rag_entity: ' || count(*) FROM data.rag_entity
UNION ALL
SELECT 'rag_relationship: ' || count(*) FROM data.rag_relationship
UNION ALL
SELECT 'rag_entity_passage: ' || count(*) FROM data.rag_entity_passage
UNION ALL
SELECT 'rag_rule_entity_map: ' || count(*) FROM data.rag_rule_entity_map;

-- 查看实体分布
SELECT entity_type, count(*) as cnt
FROM data.rag_entity
GROUP BY entity_type
ORDER BY cnt DESC;

-- 查看关系类型分布
SELECT relation_type, count(*) as cnt
FROM data.rag_relationship
GROUP BY relation_type
ORDER BY cnt DESC;
