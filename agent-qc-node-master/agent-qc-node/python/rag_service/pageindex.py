"""
pageindex.py - PageIndex 定向向量检索
在 Stage1 路由缩小的 doc/passage 范围内，做向量相似度搜索
"""
import logging
from db import generate_query_embedding, get_conn, put_conn

logger = logging.getLogger("rag.pageindex")


def pageindex_search(
    query_text: str,
    note_qc_code: str = None,
    doc_ids: list = None,
    passage_ids: list = None,
    similarity_threshold: float = 0.5,
    limit_count: int = 3,
) -> list:
    """
    PageIndex 定向检索：在指定的 doc_ids / passage_ids 范围内做向量相似度搜索

    检索策略：
    1. 如果 passage_ids 非空：只在指定段落中搜索（最精确）
    2. 如果只有 doc_ids：在指定文档的所有段落中搜索
    3. 同时搜索 rag_passage 和 rag_verify（用 note_qc_code 过滤），合并结果

    返回格式与 rag_verify_search 一致：[{txt, note_qc_code, similarity, source}, ...]
    """
    results = []

    try:
        # 1. 生成查询向量（复用 PG 的 generate_embedding）
        query_embedding = generate_query_embedding(query_text)
        logger.info(f"[pageindex] 查询向量生成完成, qc={note_qc_code}")

        # 2. 在 rag_passage 中定向搜索
        # 多书场景放大 SQL LIMIT：每本书至少需要 limit_count 条候选，
        # 否则全局 top-N 可能全来自同一本书，合并函数无法保证每本有代表
        num_books = max(len(doc_ids), 1) if doc_ids else 1
        expanded_limit = limit_count * num_books

        # 两级放宽策略：先限定 passage_ids（精确段落，map 学习时锁定）搜索；
        # 若零结果则自动放宽到 doc_ids 全书范围再搜一次。
        # 原因：map 锁定的段落可能不含与本次查询最相关的段落（查询角度不同），
        # 直接零结果会导致降级到关键词搜索，漏掉本可命中的向量知识。
        passage_results = []
        if passage_ids:
            passage_results = _search_passages(
                query_embedding, doc_ids, passage_ids, similarity_threshold, expanded_limit
            )
            if not passage_results:
                logger.info(
                    f"[pageindex] 限定段落零结果，放宽到全书范围重搜 qc={note_qc_code}, "
                    f"passages={len(passage_ids)} → docs={doc_ids}"
                )
                passage_results = _search_passages(
                    query_embedding, doc_ids, None, similarity_threshold, expanded_limit
                )
        else:
            passage_results = _search_passages(
                query_embedding, doc_ids, None, similarity_threshold, expanded_limit
            )
        results.extend(passage_results)

        # 3. 同时在 rag_verify 中搜索（用 note_qc_code 过滤）
        verify_results = _search_verify(
            query_embedding, note_qc_code, similarity_threshold, limit_count
        )
        results.extend(verify_results)

        # 4. 每本书保底 + 全局排序填充（保证多书场景每本都有代表）
        # 有效返回数 = max(limit_count, 书数)，确保每本书至少一条
        effective_limit = max(limit_count, num_books)
        results = _merge_with_per_book_guarantee(results, effective_limit)

        logger.info(
            f"[pageindex] qc={note_qc_code}, "
            f"passage命中={len(passage_results)}, verify命中={len(verify_results)}, "
            f"最终返回={len(results)}"
        )

    except Exception as e:
        logger.error(f"[pageindex] 检索失败: {e}")
        return []

    return results


def _merge_with_per_book_guarantee(results: list, limit_count: int) -> list:
    """
    合并策略：保证每本书至少有一条代表结果，剩余名额按相似度全局填充。

    算法：
    1. 按 doc_id 分组（无 doc_id 的归为特殊组，如 verify 来源）
    2. 每组取相似度最高的一条作为"保底代表"
    3. 剩余名额从未选中的结果中按相似度降序填充
    4. 最终按相似度降序返回

    边界处理：
    - 书的数量 > limit_count：按各组最高相似度排序，取前 limit_count 本
    - 单书场景：退化为全局 top-N（行为不变）
    """
    if not results:
        return []

    # 按 doc_id 分组（doc_id 为 None 的按 source 区分，每条独立一组）
    groups = {}  # key: doc_id or unique_key → list of results
    for r in results:
        doc_id = r.get("doc_id")
        if doc_id is not None:
            key = f"doc_{doc_id}"
        else:
            # verify 来源或无 doc_id 的，每条独立
            key = f"other_{id(r)}"
        groups.setdefault(key, []).append(r)

    # 每组取最佳代表
    representatives = []
    for key, group in groups.items():
        best = max(group, key=lambda x: x.get("similarity", 0))
        representatives.append(best)

    # 按相似度降序排列代表
    representatives.sort(key=lambda x: x.get("similarity", 0), reverse=True)

    # 如果书的数量超过 limit_count，只保留 top 代表
    if len(representatives) > limit_count:
        representatives = representatives[:limit_count]

    selected = set(id(r) for r in representatives)

    # 剩余名额：从未选中的结果中按相似度填充
    remaining_slots = limit_count - len(representatives)
    if remaining_slots > 0:
        candidates = [
            r for r in results if id(r) not in selected
        ]
        candidates.sort(key=lambda x: x.get("similarity", 0), reverse=True)
        representatives.extend(candidates[:remaining_slots])

    # 最终按相似度降序
    representatives.sort(key=lambda x: x.get("similarity", 0), reverse=True)
    return representatives[:limit_count]


def _search_passages(
    query_embedding, doc_ids, passage_ids, threshold, limit
) -> list:
    """在 rag_passage 中做 scoped vector search"""
    if not doc_ids and not passage_ids:
        return []

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            # 构建 WHERE 条件
            conditions = ["p.enabled = true"]
            params = [query_embedding, threshold, limit]

            if passage_ids:
                conditions.append("p.id = ANY(%s)")
                params.insert(-2, passage_ids)
            elif doc_ids:
                conditions.append("p.doc_id = ANY(%s)")
                params.insert(-2, doc_ids)

            where_clause = " AND ".join(conditions)

            sql = f"""
                SELECT
                    p.content AS txt,
                    p.section_path,
                    d.title AS doc_title,
                    1 - (p.embedding <=> %s::vector) AS similarity,
                    p.doc_id
                FROM data.rag_passage p
                JOIN data.rag_source_doc d ON p.doc_id = d.id
                WHERE {where_clause}
                  AND 1 - (p.embedding <=> %s::vector) >= %s
                ORDER BY p.embedding <=> %s::vector
                LIMIT %s
            """
            # 注意：pgvector 的 <=> 是余弦距离，1 - distance = similarity
            # 参数顺序需要调整
            # 重新构建参数（embedding 在 SQL 中出现两次）
            final_params = [query_embedding]
            if passage_ids:
                final_params.append(passage_ids)
            elif doc_ids:
                final_params.append(doc_ids)
            final_params.extend([query_embedding, threshold, query_embedding, limit])

            cur.execute(sql, final_params)
            rows = cur.fetchall()

            results = []
            for row in rows:
                results.append({
                    "txt": row[0],
                    "section_path": row[1],
                    "doc_title": row[2],
                    "similarity": float(row[3]) if row[3] else 0,
                    "doc_id": row[4],
                    "entities": [],
                    "community_summary": None,
                    "source": "passage",
                })
            return results

    except Exception as e:
        logger.error(f"[pageindex] passage搜索异常: {e}")
        return []
    finally:
        put_conn(conn)


def _search_verify(query_embedding, note_qc_code, threshold, limit) -> list:
    """在 rag_verify 中按 note_qc_code 做向量搜索"""
    if not note_qc_code:
        return []

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            sql = """
                SELECT
                    txt,
                    note_qc_code,
                    1 - (embedding <=> %s::vector) AS similarity
                FROM data.rag_verify
                WHERE note_qc_code = %s
                  AND embedding IS NOT NULL
                  AND 1 - (embedding <=> %s::vector) >= %s
                ORDER BY embedding <=> %s::vector
                LIMIT %s
            """
            cur.execute(sql, (
                query_embedding, note_qc_code,
                query_embedding, threshold,
                query_embedding, limit,
            ))
            rows = cur.fetchall()

            results = []
            for row in rows:
                results.append({
                    "txt": row[0],
                    "section_path": None,
                    "doc_title": None,
                    "note_qc_code": row[1],
                    "similarity": float(row[2]) if row[2] else 0,
                    "entities": [],
                    "community_summary": None,
                    "source": "verify",
                })
            return results

    except Exception as e:
        logger.error(f"[pageindex] verify搜索异常: {e}")
        return []
    finally:
        put_conn(conn)
