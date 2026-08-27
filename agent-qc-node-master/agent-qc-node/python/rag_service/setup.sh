#!/bin/bash
# RAG Service 一键部署脚本
# 在虚拟机上以 root 执行: bash setup.sh

DIR=/root/rag_service
mkdir -p "$DIR"
cd "$DIR"

echo "=== 创建 requirements.txt ==="
cat > requirements.txt << 'PYEOF'
# RAG Service 依赖
fastapi>=0.100.0
uvicorn>=0.23.0
psycopg2-binary>=2.9.0
pydantic>=2.0.0
PYEOF

echo "=== 创建 config.py ==="
cat > config.py << 'PYEOF'
"""
config.py - RAG 服务配置
通过环境变量或默认值配置数据库连接和服务参数
"""
import os

# ── 数据库连接 ───────────────────────────────────────────────
DB_CONN_STR = os.environ.get(
    "RAG_DB_CONN_STR",
    os.environ.get("ZK_DB_CONN_STR", "rag_user:password@localhost:5432/rag"),
)

def parse_conn_str(conn_str: str) -> dict:
    """将 user:pass@host:port/db 格式解析为 psycopg2 连接参数"""
    params = {}
    if "@" in conn_str:
        user_pass, host_db = conn_str.rsplit("@", 1)
        if ":" in user_pass:
            params["user"], params["password"] = user_pass.split(":", 1)
        else:
            params["user"] = user_pass
    else:
        host_db = conn_str

    if "/" in host_db:
        host_port, params["dbname"] = host_db.rsplit("/", 1)
    else:
        host_port = host_db

    if ":" in host_port:
        params["host"], port_str = host_port.rsplit(":", 1)
        params["port"] = int(port_str)
    else:
        params["host"] = host_port

    return params

DB_PARAMS = parse_conn_str(DB_CONN_STR)

# ── 服务配置 ───────────────────────────────────────────────
SERVICE_PORT = int(os.environ.get("RAG_SERVICE_PORT", "8100"))
DEFAULT_SIMILARITY_THRESHOLD = 0.5
DEFAULT_LIMIT_COUNT = 3
EMBEDDING_DIM = 1024
PYEOF

echo "=== 创建 db.py ==="
cat > db.py << 'PYEOF'
"""
db.py - 数据库连接池管理
"""
import logging
import psycopg2
from psycopg2 import pool
from config import DB_PARAMS, EMBEDDING_DIM

logger = logging.getLogger("rag.db")

_pool: pool.ThreadedConnectionPool = None

def get_pool() -> pool.ThreadedConnectionPool:
    global _pool
    if _pool is None:
        _pool = pool.ThreadedConnectionPool(
            minconn=2, maxconn=10, **DB_PARAMS
        )
        logger.info("数据库连接池已创建")
    return _pool

def get_conn():
    return get_pool().getconn()

def put_conn(conn, close: bool = False):
    get_pool().putconn(conn, close=close)

def generate_query_embedding(query_text: str) -> list:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT generate_embedding(%s)", (query_text,))
            row = cur.fetchone()
            if row and row[0]:
                return row[0]
            raise ValueError("generate_embedding() 返回空结果")
    finally:
        put_conn(conn)

def execute_query(sql: str, params: tuple = None) -> list:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    finally:
        put_conn(conn)

def health_check() -> dict:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT current_database(), current_user, count(*) FROM data.rag_verify")
            row = cur.fetchone()
            return {
                "database": row[0],
                "user": row[1],
                "rag_verify_count": row[2],
                "status": "ok",
            }
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        put_conn(conn)
PYEOF

echo "=== 创建 main.py ==="
cat > main.py << 'PYEOF'
"""
main.py - RAG 服务入口（FastAPI）
"""
import logging
from typing import List, Optional

from fastapi import FastAPI
from pydantic import BaseModel

from config import SERVICE_PORT, DEFAULT_SIMILARITY_THRESHOLD, DEFAULT_LIMIT_COUNT
from db import health_check, generate_query_embedding, get_conn, put_conn
from pageindex import pageindex_search
from graph_search import graph_search

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("rag.main")

app = FastAPI(title="RAG Service", version="1.0.0")

class PageIndexSearchRequest(BaseModel):
    query_text: str
    note_qc_code: Optional[str] = None
    doc_ids: Optional[List[int]] = None
    passage_ids: Optional[List[int]] = None
    similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD
    limit_count: int = DEFAULT_LIMIT_COUNT

class GraphSearchRequest(BaseModel):
    query_text: str
    note_qc_code: Optional[str] = None
    entity_types: Optional[List[str]] = None
    max_hops: int = 2
    similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD
    limit_count: int = DEFAULT_LIMIT_COUNT

class VerifySearchRequest(BaseModel):
    query_text: str
    note_qc_code: str
    similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD
    limit_count: int = DEFAULT_LIMIT_COUNT

@app.get("/health")
def health():
    return health_check()

@app.post("/rag_pageindex_search")
def api_pageindex_search(req: PageIndexSearchRequest):
    logger.info(f"[API] /rag_pageindex_search qc={req.note_qc_code}")
    results = pageindex_search(
        query_text=req.query_text,
        note_qc_code=req.note_qc_code,
        doc_ids=req.doc_ids or [],
        passage_ids=req.passage_ids or [],
        similarity_threshold=req.similarity_threshold,
        limit_count=req.limit_count,
    )
    return results

@app.post("/rag_graph_search")
def api_graph_search(req: GraphSearchRequest):
    logger.info(f"[API] /rag_graph_search qc={req.note_qc_code}")
    results = graph_search(
        query_text=req.query_text,
        note_qc_code=req.note_qc_code,
        entity_types=req.entity_types,
        max_hops=req.max_hops,
        similarity_threshold=req.similarity_threshold,
        limit_count=req.limit_count,
    )
    return results

@app.post("/rag_verify_search")
def api_rag_verify_search(req: VerifySearchRequest):
    logger.info(f"[API] /rag_verify_search qc={req.note_qc_code}")
    try:
        query_embedding = generate_query_embedding(req.query_text)
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                sql = """
                    SELECT txt, note_qc_code,
                        1 - (embedding <=> %s::vector) AS similarity
                    FROM data.rag_verify
                    WHERE note_qc_code = %s AND enabled = true
                      AND 1 - (embedding <=> %s::vector) >= %s
                    ORDER BY embedding <=> %s::vector
                    LIMIT %s
                """
                cur.execute(sql, (
                    query_embedding, req.note_qc_code,
                    query_embedding, req.similarity_threshold,
                    query_embedding, req.limit_count,
                ))
                rows = cur.fetchall()
                return [
                    {"txt": r[0], "note_qc_code": r[1], "similarity": float(r[2]) if r[2] else 0}
                    for r in rows
                ]
        finally:
            put_conn(conn)
    except Exception as e:
        logger.error(f"[API] rag_verify_search error: {e}")
        return []

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=SERVICE_PORT)
PYEOF

echo "=== 创建 pageindex.py ==="
cat > pageindex.py << 'PYEOF'
"""
pageindex.py - PageIndex 定向向量检索
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
    results = []
    try:
        query_embedding = generate_query_embedding(query_text)
        logger.info(f"[pageindex] query vector ready, qc={note_qc_code}")

        passage_results = _search_passages(
            query_embedding, doc_ids, passage_ids, similarity_threshold, limit_count
        )
        results.extend(passage_results)

        verify_results = _search_verify(
            query_embedding, note_qc_code, similarity_threshold, limit_count
        )
        results.extend(verify_results)

        results.sort(key=lambda x: x.get("similarity", 0), reverse=True)
        results = results[:limit_count]
        logger.info(f"[pageindex] passage={len(passage_results)}, verify={len(verify_results)}, total={len(results)}")
    except Exception as e:
        logger.error(f"[pageindex] error: {e}")
        return []
    return results

def _search_passages(query_embedding, doc_ids, passage_ids, threshold, limit) -> list:
    if not doc_ids and not passage_ids:
        return []
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            conditions = ["p.enabled = true"]
            final_params = [query_embedding]
            if passage_ids:
                conditions.append("p.id = ANY(%s)")
                final_params.append(passage_ids)
            elif doc_ids:
                conditions.append("p.doc_id = ANY(%s)")
                final_params.append(doc_ids)
            final_params.extend([query_embedding, threshold, query_embedding, limit])
            where_clause = " AND ".join(conditions)
            sql = f"""
                SELECT p.content AS txt, p.section_path, d.title AS doc_title,
                    1 - (p.embedding <=> %s::vector) AS similarity
                FROM data.rag_passage p
                JOIN data.rag_source_doc d ON p.doc_id = d.id
                WHERE {where_clause}
                  AND 1 - (p.embedding <=> %s::vector) >= %s
                ORDER BY p.embedding <=> %s::vector
                LIMIT %s
            """
            cur.execute(sql, final_params)
            rows = cur.fetchall()
            return [
                {"txt": r[0], "section_path": r[1], "doc_title": r[2],
                 "similarity": float(r[3]) if r[3] else 0, "source": "passage"}
                for r in rows
            ]
    except Exception as e:
        logger.error(f"[pageindex] passage error: {e}")
        return []
    finally:
        put_conn(conn)

def _search_verify(query_embedding, note_qc_code, threshold, limit) -> list:
    if not note_qc_code:
        return []
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            sql = """
                SELECT txt, note_qc_code,
                    1 - (embedding <=> %s::vector) AS similarity
                FROM data.rag_verify
                WHERE note_qc_code = %s AND enabled = true
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
            return [
                {"txt": r[0], "note_qc_code": r[1],
                 "similarity": float(r[2]) if r[2] else 0, "source": "verify"}
                for r in rows
            ]
    except Exception as e:
        logger.error(f"[pageindex] verify error: {e}")
        return []
    finally:
        put_conn(conn)
PYEOF

echo "=== 创建 graph_search.py ==="
cat > graph_search.py << 'PYEOF'
"""
graph_search.py - GraphRAG 知识图谱检索
"""
import logging
from db import generate_query_embedding, get_conn, put_conn

logger = logging.getLogger("rag.graph")

def graph_search(
    query_text: str,
    note_qc_code: str = None,
    entity_types: list = None,
    max_hops: int = 2,
    similarity_threshold: float = 0.5,
    limit_count: int = 3,
) -> list:
    results = []
    try:
        query_embedding = generate_query_embedding(query_text)
        logger.info(f"[graph] query vector ready, qc={note_qc_code}")

        seed_entities = _match_seed_entities(
            query_embedding, note_qc_code, entity_types, similarity_threshold
        )
        if not seed_entities:
            logger.info("[graph] no seed entities, returning empty")
            return []

        seed_ids = [e["id"] for e in seed_entities]
        logger.info(f"[graph] seeds: {seed_ids}")

        subgraph_entities, subgraph_relationships = _traverse_graph(seed_ids, max_hops)
        logger.info(f"[graph] subgraph: {len(subgraph_entities)} entities, {len(subgraph_relationships)} rels")

        entity_ids = [e["id"] for e in subgraph_entities]
        community_summaries = _get_community_summaries(entity_ids)
        passage_texts = _get_related_passages(entity_ids)

        for p in passage_texts[:limit_count]:
            results.append({
                "txt": p["content"],
                "section_path": p.get("section_path"),
                "doc_title": p.get("doc_title"),
                "entities": p.get("entity_names", []),
                "community_summary": p.get("community_summary"),
                "source": "graph",
            })

        if len(results) < limit_count:
            for cs in community_summaries:
                if len(results) >= limit_count:
                    break
                results.append({
                    "txt": cs["summary"],
                    "label": cs.get("label"),
                    "source": "graph_community",
                })

        logger.info(f"[graph] returning {len(results)} results")
    except Exception as e:
        logger.error(f"[graph] error: {e}")
        return []
    return results

def _match_seed_entities(query_embedding, note_qc_code, entity_types, threshold) -> list:
    seen_ids = set()
    results = []
    if note_qc_code:
        mapped = _get_rule_mapped_entities(note_qc_code)
        for e in mapped:
            if e["id"] not in seen_ids:
                seen_ids.add(e["id"])
                results.append(e)
    similar = _match_entities_by_vector(query_embedding, entity_types, threshold)
    for e in similar:
        if e["id"] not in seen_ids:
            seen_ids.add(e["id"])
            results.append(e)
    return results

def _get_rule_mapped_entities(note_qc_code: str) -> list:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            sql = """
                SELECT e.id, e.name, e.entity_type, e.summary, e.confidence, m.relevance
                FROM data.rag_rule_entity_map m
                JOIN data.rag_entity e ON m.entity_id = e.id
                WHERE m.note_qc_code = %s AND m.enabled = true AND e.enabled = true
                ORDER BY m.relevance DESC LIMIT 20
            """
            cur.execute(sql, (note_qc_code,))
            return [
                {"id": r[0], "name": r[1], "entity_type": r[2], "summary": r[3],
                 "confidence": r[4], "source": "rule_map"}
                for r in cur.fetchall()
            ]
    except Exception as e:
        logger.error(f"[graph] rule map error: {e}")
        return []
    finally:
        put_conn(conn)

def _match_entities_by_vector(query_embedding, entity_types, threshold) -> list:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            if entity_types:
                sql = """
                    SELECT id, name, entity_type, summary, confidence
                    FROM data.rag_entity
                    WHERE enabled = true AND entity_type = ANY(%s)
                      AND confidence >= 0.5
                      AND 1 - (embedding <=> %s::vector) >= %s
                    ORDER BY embedding <=> %s::vector LIMIT 10
                """
                cur.execute(sql, (entity_types, query_embedding, threshold, query_embedding))
            else:
                sql = """
                    SELECT id, name, entity_type, summary, confidence
                    FROM data.rag_entity
                    WHERE enabled = true AND confidence >= 0.5
                      AND 1 - (embedding <=> %s::vector) >= %s
                    ORDER BY embedding <=> %s::vector LIMIT 10
                """
                cur.execute(sql, (query_embedding, threshold, query_embedding))
            return [
                {"id": r[0], "name": r[1], "entity_type": r[2], "summary": r[3],
                 "confidence": r[4], "source": "vector"}
                for r in cur.fetchall()
            ]
    except Exception as e:
        logger.error(f"[graph] vector match error: {e}")
        return []
    finally:
        put_conn(conn)

def _traverse_graph(seed_ids: list, max_hops: int) -> tuple:
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
                sql = """
                    SELECT r.id, r.source_id, r.target_id, r.relation_type, r.description,
                           se.name AS source_name, te.name AS target_name
                    FROM data.rag_relationship r
                    JOIN data.rag_entity se ON r.source_id = se.id
                    JOIN data.rag_entity te ON r.target_id = te.id
                    WHERE r.enabled = true
                      AND (r.source_id = ANY(%s) OR r.target_id = ANY(%s))
                """
                cur.execute(sql, (current_frontier, current_frontier))
                rows = cur.fetchall()
                next_frontier = []
                for row in rows:
                    all_relationships.append({
                        "id": row[0], "source_id": row[1], "target_id": row[2],
                        "relation_type": row[3], "description": row[4],
                        "source_name": row[5], "target_name": row[6],
                    })
                    for nid in [row[1], row[2]]:
                        if nid not in visited:
                            visited.add(nid)
                            next_frontier.append(nid)
                current_frontier = next_frontier
        with conn.cursor() as cur:
            sql = "SELECT id, name, entity_type, summary FROM data.rag_entity WHERE id = ANY(%s)"
            cur.execute(sql, (list(visited),))
            entities = [
                {"id": r[0], "name": r[1], "entity_type": r[2], "summary": r[3]}
                for r in cur.fetchall()
            ]
        return entities, all_relationships
    except Exception as e:
        logger.error(f"[graph] traverse error: {e}")
        return [], []
    finally:
        put_conn(conn)

def _get_community_summaries(entity_ids: list) -> list:
    if not entity_ids:
        return []
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            sql = """
                SELECT id, level, label, summary FROM data.rag_community
                WHERE enabled = true AND entity_ids && %s::int[]
                ORDER BY level DESC LIMIT 5
            """
            cur.execute(sql, (entity_ids,))
            return [
                {"id": r[0], "level": r[1], "label": r[2], "summary": r[3]}
                for r in cur.fetchall()
            ]
    except Exception as e:
        logger.error(f"[graph] community error: {e}")
        return []
    finally:
        put_conn(conn)

def _get_related_passages(entity_ids: list) -> list:
    if not entity_ids:
        return []
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            sql = """
                SELECT DISTINCT p.id, p.content, p.section_path,
                    d.title AS doc_title,
                    ARRAY_AGG(DISTINCT e.name) AS entity_names
                FROM data.rag_entity_passage ep
                JOIN data.rag_passage p ON ep.passage_id = p.id
                JOIN data.rag_source_doc d ON p.doc_id = d.id
                JOIN data.rag_entity e ON ep.entity_id = e.id
                WHERE ep.entity_id = ANY(%s) AND p.enabled = true
                GROUP BY p.id, p.content, p.section_path, d.title
                LIMIT 10
            """
            cur.execute(sql, (entity_ids,))
            return [
                {"id": r[0], "content": r[1], "section_path": r[2],
                 "doc_title": r[3], "entity_names": r[4]}
                for r in cur.fetchall()
            ]
    except Exception as e:
        logger.error(f"[graph] passages error: {e}")
        return []
    finally:
        put_conn(conn)
PYEOF

echo "=== 完成！验证文件 ==="
ls -la "$DIR"
echo ""
echo "所有文件已创建在 $DIR"
echo "下一步: pip3 install -r $DIR/requirements.txt"
