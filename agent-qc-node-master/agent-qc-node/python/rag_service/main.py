"""
main.py - RAG 服务入口（FastAPI）
提供 /rag_pageindex_search 和 /rag_graph_search 两个端点
以及 /health 健康检查和 /rag_verify_search（兼容现有接口）

启动方式:
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8100

环境变量:
    RAG_DB_CONN_STR=rag_user:password@host:5432/rag
    RAG_SERVICE_PORT=8100
"""
import logging
from typing import List, Optional

from fastapi import FastAPI
from pydantic import BaseModel

from config import SERVICE_PORT, DEFAULT_SIMILARITY_THRESHOLD, DEFAULT_LIMIT_COUNT, LOG_LEVEL
from db import health_check, generate_query_embedding, get_conn, put_conn
from pageindex import pageindex_search
from graph_search import graph_search
from lightrag_search import lightrag_search, lightrag_health_check
from logging_config import setup_logging, TracingMiddleware

# ── 结构化 JSON 日志 ────────────────────────────────────────
setup_logging(level=LOG_LEVEL)
logger = logging.getLogger("rag.main")

# ── FastAPI 应用 ──────────────────────────────────────────
app = FastAPI(title="RAG Service", version="1.1.0")
app.add_middleware(TracingMiddleware)


# ── 请求/响应模型 ─────────────────────────────────────────

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
    doc_ids: Optional[List[int]] = None  # PageIndex 联动：限定搜索范围


class VerifySearchRequest(BaseModel):
    query_text: str
    note_qc_code: str
    similarity_threshold: float = DEFAULT_SIMILARITY_THRESHOLD
    limit_count: int = DEFAULT_LIMIT_COUNT


class LightRAGSearchRequest(BaseModel):
    query_text: str
    note_qc_code: Optional[str] = None
    mode: str = "hybrid"  # naive/local/global/hybrid
    limit_count: int = DEFAULT_LIMIT_COUNT
    doc_ids: Optional[List[int]] = None  # PageIndex 联动


class LightRAGInsertRequest(BaseModel):
    document_text: str
    doc_id: Optional[int] = None
    file_path: Optional[str] = None  # 文档溯源路径（如 "医患沟通（第3版）/第5章"）


# ── 端点 ──────────────────────────────────────────────────

@app.get("/health")
def health():
    """健康检查"""
    return health_check()


@app.post("/rag_pageindex_search")
def api_pageindex_search(req: PageIndexSearchRequest):
    """
    PageIndex 定向检索
    在指定的 doc_ids / passage_ids 范围内做向量相似度搜索
    """
    logger.info(
        f"[API] /rag_pageindex_search qc={req.note_qc_code}, "
        f"docs={req.doc_ids}, passages={req.passage_ids}"
    )
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
    """
    GraphRAG 图谱检索
    实体匹配 → 图遍历 → 社区摘要 → 关联段落
    """
    logger.info(
        f"[API] /rag_graph_search qc={req.note_qc_code}, "
        f"types={req.entity_types}, hops={req.max_hops}"
    )
    results = graph_search(
        query_text=req.query_text,
        note_qc_code=req.note_qc_code,
        entity_types=req.entity_types,
        max_hops=req.max_hops,
        similarity_threshold=req.similarity_threshold,
        limit_count=req.limit_count,
        doc_ids=req.doc_ids,
    )
    return results


@app.post("/rag_lightrag_search")
def api_lightrag_search(req: LightRAGSearchRequest):
    """
    LightRAG 知识图谱检索（轻量级替代 GraphRAG）
    支持 hybrid/local/global 三种检索模式
    """
    logger.info(
        f"[API] /rag_lightrag_search qc={req.note_qc_code}, "
        f"mode={req.mode}"
    )
    results = lightrag_search(
        query_text=req.query_text,
        note_qc_code=req.note_qc_code,
        mode=req.mode,
        limit_count=req.limit_count,
        doc_ids=req.doc_ids,
    )
    return results


@app.get("/lightrag_health")
def lightrag_health():
    """LightRAG 健康检查"""
    return lightrag_health_check()


@app.post("/rag_lightrag_insert")
async def api_lightrag_insert(req: LightRAGInsertRequest):
    """
    LightRAG 文档插入（增量索引）
    """
    from lightrag_search import lightrag_insert_document
    logger.info(f"[API] /rag_lightrag_insert doc_id={req.doc_id}, file_path={req.file_path}")
    success = await lightrag_insert_document(req.document_text, req.doc_id, req.file_path)
    return {"success": success}


@app.post("/rag_verify_search")
def api_rag_verify_search(req: VerifySearchRequest):
    """
    兼容现有 rag_verify_search 接口
    在 rag_verify 表中按 note_qc_code 做向量相似度搜索
    """
    logger.info(f"[API] /rag_verify_search qc={req.note_qc_code}")
    try:
        query_embedding = generate_query_embedding(req.query_text)

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
                    query_embedding, req.note_qc_code,
                    query_embedding, req.similarity_threshold,
                    query_embedding, req.limit_count,
                ))
                rows = cur.fetchall()

                return [
                    {
                        "txt": r[0],
                        "note_qc_code": r[1],
                        "similarity": float(r[2]) if r[2] else 0,
                    }
                    for r in rows
                ]
        finally:
            put_conn(conn)

    except Exception as e:
        logger.error(f"[API] rag_verify_search 失败: {e}")
        return []


# ── 启动入口 ──────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=SERVICE_PORT)
