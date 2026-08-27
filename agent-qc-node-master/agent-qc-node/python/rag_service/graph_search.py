"""
graph_search.py - GraphRAG 知识图谱检索
通过实体匹配 → 图遍历 → 社区摘要 → 关联段落，实现跨文档关联推理
"""
import logging
from db import generate_query_embedding, get_conn, put_conn

logger = logging.getLogger("rag.graph")

# ── 关系类型权重 ─────────────────────────────────────────────
# 权重越高表示该关系在质控场景下越重要
# 用于图遍历后对关联段落进行加权排序
RELATION_WEIGHTS = {
    "confirms_diagnosis": 1.0,   # 确诊关系：最权威
    "treated_by": 0.9,           # 治疗关系：核心质控点
    "supports_diagnosis": 0.7,   # 支持诊断：辅助信息
    "indicates": 0.5,            # 提示关系：可能指向
    "risk_factor_for": 0.4,      # 风险因素：预防参考
    "accompanied_by": 0.3,       # 伴随关系：弱关联
}
DEFAULT_RELATION_WEIGHT = 0.5   # 未知关系类型的默认权重

# ── 图遍历安全参数 ─────────────────────────────────────────
MAX_ENTITIES_PER_HOP = 30       # 每跳最多收集的实体数，防止子图爆炸
MIN_ENTITY_CONFIDENCE = 0.5     # 实体最低置信度，过滤低质量实体


def graph_search(
    query_text: str,
    note_qc_code: str = None,
    entity_types: list = None,
    max_hops: int = 2,
    similarity_threshold: float = 0.5,
    limit_count: int = 3,
    min_confidence: float = MIN_ENTITY_CONFIDENCE,
    doc_ids: list = None,
) -> list:
    """
    GraphRAG 图谱检索

    流程：
    1. 用查询向量在 rag_entity 中匹配相关实体
    2. 从匹配实体出发，max_hops 跳内收集邻居实体和关系
    3. 找到这些实体所属的社区，取社区摘要
    4. 通过 rag_entity_passage 找到关联段落原文
    5. 合并返回：实体描述 + 关系描述 + 社区摘要 + 原文段落

    参数：
    - doc_ids: PageIndex 路由命中的文档 ID，用于缩小搜索范围
    """
    results = []

    try:
        # 1. 生成查询向量
        query_embedding = generate_query_embedding(query_text)
        logger.info(f"[graph] 查询向量生成完成, qc={note_qc_code}")

        # 2. 匹配种子实体（优先走规则-实体映射，再向量补充）
        seed_entities = _match_seed_entities(
            query_embedding, note_qc_code, entity_types, similarity_threshold, min_confidence
        )
        if not seed_entities:
            logger.info("[graph] 未匹配到种子实体，返回空")
            return []

        seed_ids = [e["id"] for e in seed_entities]
        logger.info(f"[graph] 种子实体: {seed_ids}")

        # 3. 图遍历：收集 max_hops 跳内的子图
        subgraph_entities, subgraph_relationships = _traverse_graph(seed_ids, max_hops)
        logger.info(
            f"[graph] 子图: {len(subgraph_entities)} 实体, {len(subgraph_relationships)} 关系"
        )

        # 4. 获取社区摘要
        entity_ids = [e["id"] for e in subgraph_entities]
        community_summaries = _get_community_summaries(entity_ids)

        # 5. 获取关联段落原文（按关系权重排序，如果有 doc_ids 则限定范围）
        passage_texts = _get_related_passages(entity_ids, subgraph_relationships, doc_ids)

        # 6. 组装结果
        # 优先返回段落原文（最直接的知识单元）
        for p in passage_texts[:limit_count]:
            results.append({
                "txt": p["content"],
                "section_path": p.get("section_path"),
                "doc_title": p.get("doc_title"),
                "similarity": 0,
                "entities": p.get("entity_names", []),
                "community_summary": p.get("community_summary"),
                "source": "graph",
            })

        # 如果段落不够，用社区摘要补充
        if len(results) < limit_count:
            for cs in community_summaries:
                if len(results) >= limit_count:
                    break
                results.append({
                    "txt": cs["summary"],
                    "section_path": None,
                    "doc_title": None,
                    "similarity": 0,
                    "entities": [],
                    "community_summary": cs.get("summary"),
                    "label": cs.get("label"),
                    "source": "graph_community",
                })

        logger.info(f"[graph] 最终返回 {len(results)} 条结果")

    except Exception as e:
        logger.error(f"[graph] 检索失败: {e}")
        return []

    return results


def _match_seed_entities(
    query_embedding, note_qc_code, entity_types, threshold, min_confidence=0.5
) -> list:
    """
    匹配种子实体（合并两种来源）：
    1. 规则-实体映射（rag_rule_entity_map）：已知的规则→实体对应关系，精准可靠
    2. 向量相似度（rag_entity.embedding）：语义匹配，覆盖未建映射的实体
    两种来源合并去重，按 relevance 和相似度综合排序
    """
    seen_ids = set()
    results = []

    # 来源 1: 规则-实体映射（零向量，纯 SQL）
    if note_qc_code:
        mapped = _get_rule_mapped_entities(note_qc_code)
        for e in mapped:
            if e["id"] not in seen_ids:
                seen_ids.add(e["id"])
                results.append(e)

    # 来源 2: 向量相似度匹配（补充未映射的实体）
    similar = _match_entities_by_vector(query_embedding, entity_types, threshold, min_confidence)
    for e in similar:
        if e["id"] not in seen_ids:
            seen_ids.add(e["id"])
            results.append(e)

    return results


def _get_rule_mapped_entities(note_qc_code: str) -> list:
    """从 rag_rule_entity_map 获取规则关联的实体（精准映射，零向量）"""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            sql = """
                SELECT e.id, e.name, e.entity_type, e.summary, e.confidence,
                       m.relevance
                FROM data.rag_rule_entity_map m
                JOIN data.rag_entity e ON m.entity_id = e.id
                WHERE m.note_qc_code = %s AND m.enabled = true AND e.enabled = true
                ORDER BY m.relevance DESC
                LIMIT 20
            """
            cur.execute(sql, (note_qc_code,))
            return [
                {
                    "id": r[0], "name": r[1], "entity_type": r[2],
                    "summary": r[3], "confidence": r[4],
                    "source": "rule_map",
                }
                for r in cur.fetchall()
            ]
    except Exception as e:
        logger.error(f"[graph] 规则映射查询异常: {e}")
        return []
    finally:
        put_conn(conn)


def _match_entities_by_vector(query_embedding, entity_types, threshold, min_confidence=0.5) -> list:
    """在 rag_entity 中用向量相似度匹配种子实体，过滤低可信度"""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            if entity_types:
                sql = """
                    SELECT id, name, entity_type, summary, confidence
                    FROM data.rag_entity
                    WHERE enabled = true AND entity_type = ANY(%s)
                      AND confidence >= %s
                      AND 1 - (embedding <=> %s::vector) >= %s
                    ORDER BY embedding <=> %s::vector
                    LIMIT 10
                """
                cur.execute(sql, (entity_types, min_confidence, query_embedding, threshold, query_embedding))
            else:
                sql = """
                    SELECT id, name, entity_type, summary, confidence
                    FROM data.rag_entity
                    WHERE enabled = true
                      AND confidence >= %s
                      AND 1 - (embedding <=> %s::vector) >= %s
                    ORDER BY embedding <=> %s::vector
                    LIMIT 10
                """
                cur.execute(sql, (min_confidence, query_embedding, threshold, query_embedding))

            rows = cur.fetchall()
            return [
                {
                    "id": r[0], "name": r[1], "entity_type": r[2],
                    "summary": r[3], "confidence": r[4],
                    "source": "vector",
                }
                for r in rows
            ]
    except Exception as e:
        logger.error(f"[graph] 实体匹配异常: {e}")
        return []
    finally:
        put_conn(conn)


def _traverse_graph(seed_ids: list, max_hops: int) -> tuple:
    """
    从种子实体出发，BFS 遍历 max_hops 跳，收集子图
    安全机制：
      - 每跳最多收集 MAX_ENTITIES_PER_HOP 个新实体，防止子图爆炸
      - 关系查询不包含 enabled 字段过滤（该表无此列）
    返回 (entities, relationships)
    """
    if not seed_ids:
        return [], []

    visited = set(seed_ids)
    current_frontier = list(seed_ids)
    all_relationships = []

    conn = get_conn()
    try:
        for hop in range(max_hops):
            if not current_frontier:
                break

            with conn.cursor() as cur:
                # 查找从当前前沿出发的所有关系
                sql = """
                    SELECT r.id, r.source_id, r.target_id, r.relation_type, r.description,
                           r.confidence AS rel_confidence,
                           se.name AS source_name, te.name AS target_name,
                           se.confidence AS source_conf, te.confidence AS target_conf
                    FROM data.rag_relationship r
                    JOIN data.rag_entity se ON r.source_id = se.id
                    JOIN data.rag_entity te ON r.target_id = te.id
                    WHERE r.source_id = ANY(%s) OR r.target_id = ANY(%s)
                """
                cur.execute(sql, (current_frontier, current_frontier))
                rows = cur.fetchall()

                next_frontier = []
                hop_new_entities = 0  # 本跳新增实体计数
                for row in rows:
                    rel = {
                        "id": row[0],
                        "source_id": row[1],
                        "target_id": row[2],
                        "relation_type": row[3],
                        "description": row[4],
                        "source_name": row[6],
                        "target_name": row[7],
                        "hop": hop,  # 记录在哪一跳发现的
                    }
                    all_relationships.append(rel)

                    # 发现新节点（受每跳实体数上限保护）
                    for nid in [row[1], row[2]]:
                        if nid not in visited and hop_new_entities < MAX_ENTITIES_PER_HOP:
                            visited.add(nid)
                            next_frontier.append(nid)
                            hop_new_entities += 1

                if hop_new_entities >= MAX_ENTITIES_PER_HOP:
                    logger.warning(f"[graph] 第{hop}跳实体数达上限 {MAX_ENTITIES_PER_HOP}，截断")

                current_frontier = next_frontier

        # 获取所有访问过的实体详情
        with conn.cursor() as cur:
            sql = """
                SELECT id, name, entity_type, summary, confidence
                FROM data.rag_entity
                WHERE id = ANY(%s)
            """
            cur.execute(sql, (list(visited),))
            entities = [
                {"id": r[0], "name": r[1], "entity_type": r[2], "summary": r[3], "confidence": r[4]}
                for r in cur.fetchall()
            ]

        logger.info(
            f"[graph] 遍历完成: {len(entities)} 实体, {len(all_relationships)} 关系, "
            f"{max_hops} 跳上限"
        )
        return entities, all_relationships

    except Exception as e:
        logger.error(f"[graph] 图遍历异常: {e}")
        return [], []
    finally:
        put_conn(conn)


def _get_community_summaries(entity_ids: list) -> list:
    """获取包含指定实体的社区摘要"""
    if not entity_ids:
        return []

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            sql = """
                SELECT id, level, label, summary
                FROM data.rag_community
                WHERE enabled = true
                  AND entity_ids && %s::int[]
                ORDER BY level DESC
                LIMIT 5
            """
            cur.execute(sql, (entity_ids,))
            return [
                {"id": r[0], "level": r[1], "label": r[2], "summary": r[3]}
                for r in cur.fetchall()
            ]
    except Exception as e:
        logger.error(f"[graph] 社区摘要查询异常: {e}")
        return []
    finally:
        put_conn(conn)


def _get_related_passages(entity_ids: list, relationships: list = None, doc_ids: list = None) -> list:
    """
    通过 rag_entity_passage 获取关联段落原文
    如果有 relationships 参数，会按关系权重排序段落（高权重关系关联的段落优先）
    如果有 doc_ids 参数，只返回这些文档下的段落（PageIndex 联动）
    """
    if not entity_ids:
        return []

    # 构建实体权重映射：实体关联的关系权重越高，该实体关联的段落排名越靠前
    entity_weight_map = {}
    _warned_unknown_types = set()  # 模块级去重，避免同一类型重复告警
    if relationships:
        for rel in relationships:
            rel_type = rel.get("relation_type", "")
            if rel_type and rel_type not in RELATION_WEIGHTS and rel_type not in _warned_unknown_types:
                logger.warning(f"[graph] 未知关系类型 '{rel_type}'，使用默认权重 {DEFAULT_RELATION_WEIGHT}，建议补充到 RELATION_WEIGHTS")
                _warned_unknown_types.add(rel_type)
            weight = RELATION_WEIGHTS.get(rel_type, DEFAULT_RELATION_WEIGHT)
            for eid in [rel.get("source_id"), rel.get("target_id")]:
                if eid is not None:
                    entity_weight_map[eid] = max(entity_weight_map.get(eid, 0), weight)

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            sql = """
                SELECT DISTINCT
                    p.id, p.content, p.section_path,
                    d.title AS doc_title,
                    ARRAY_AGG(DISTINCT e.name) AS entity_names,
                    ARRAY_AGG(DISTINCT e.id) AS entity_ids
                FROM data.rag_entity_passage ep
                JOIN data.rag_passage p ON ep.passage_id = p.id
                JOIN data.rag_source_doc d ON p.doc_id = d.id
                JOIN data.rag_entity e ON ep.entity_id = e.id
                WHERE ep.entity_id = ANY(%s)
                  AND p.enabled = true
                  {doc_filter}
                GROUP BY p.id, p.content, p.section_path, d.title
                LIMIT 20
            """.format(doc_filter="AND p.doc_id = ANY(%s)" if doc_ids else "")

            params = [entity_ids]
            if doc_ids:
                params.append(doc_ids)
            cur.execute(sql, params)
            rows = cur.fetchall()

            # 按关系权重排序：段落关联的实体权重之和越高，排名越前
            results = []
            for r in rows:
                passage_entity_ids = r[5] if r[5] else []
                # 计算该段落的关系权重得分
                passage_score = sum(
                    entity_weight_map.get(eid, DEFAULT_RELATION_WEIGHT)
                    for eid in passage_entity_ids
                )
                results.append({
                    "id": r[0],
                    "content": r[1],
                    "section_path": r[2],
                    "doc_title": r[3],
                    "entity_names": r[4],
                    "_weight_score": passage_score,
                })

            # 按权重得分降序排列
            results.sort(key=lambda x: x["_weight_score"], reverse=True)

            # 去掉内部评分字段
            for r in results:
                del r["_weight_score"]

            return results

    except Exception as e:
        logger.error(f"[graph] 关联段落查询异常: {e}")
        return []
    finally:
        put_conn(conn)
