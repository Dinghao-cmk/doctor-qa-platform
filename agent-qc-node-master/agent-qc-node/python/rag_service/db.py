"""
db.py - 数据库连接池管理
使用 psycopg2 连接池，提供 get_conn / execute_query / generate_query_embedding 等工具函数
"""
import logging
import psycopg2
from psycopg2 import pool
from config import DB_PARAMS, EMBEDDING_DIM, OPENAI_API_KEY, OPENAI_BASE_URL, EMBEDDING_MODEL

logger = logging.getLogger("rag.db")

# ── 连接池（懒初始化）───────────────────────────────────────
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
    """从连接池获取连接"""
    return get_pool().getconn()


def put_conn(conn, close: bool = False):
    """归还连接到连接池"""
    get_pool().putconn(conn, close=close)


def generate_query_embedding(query_text: str) -> list:
    """
    调用 OpenAI 兼容 API 生成查询向量
    优先尝试 PG 中的 generate_embedding() 函数（生产环境）；
    若不存在则直接调用 OpenAI 兼容 API（本地测试环境）。
    """
    # 方式 1: 尝试 PG 函数（生产环境）
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT generate_embedding(%s)", (query_text,))
            row = cur.fetchone()
            if row and row[0]:
                return row[0]
    except Exception:
        pass  # PG 函数不存在，回退到 API 调用
    finally:
        put_conn(conn)

    # 方式 2: 直接调用 OpenAI 兼容 API（本地/硅基流动）
    api_key = OPENAI_API_KEY
    base_url = OPENAI_BASE_URL
    model = EMBEDDING_MODEL
    if not api_key:
        raise ValueError("OPENAI_API_KEY 未设置，无法生成 embedding")

    import urllib.request
    import json as _json
    url = f"{base_url}/embeddings"
    payload = _json.dumps({"input": query_text, "model": model}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = _json.loads(resp.read().decode("utf-8"))
    embedding = data["data"][0]["embedding"]
    logger.info(f"[embedding] API 调用成功, model={model}, dim={len(embedding)}")
    return embedding


def execute_query(sql: str, params: tuple = None) -> list:
    """执行查询并返回结果列表"""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    finally:
        put_conn(conn)


def health_check() -> dict:
    """健康检查：验证数据库连接是否正常"""
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
