"""
refresh_embeddings.py - 批量刷新 rag_passage / rag_verify 的 embedding
使用 OpenAI 兼容 API（硅基流动）生成真实向量，替换 mock 随机向量

用法:
    $env:OPENAI_API_KEY="sk-xxx"
    $env:OPENAI_BASE_URL="https://api.siliconflow.cn/v1"
    $env:LIGHTRAG_EMBEDDING_MODEL="BAAI/bge-m3"
    $env:RAG_DB_CONN_STR="postgres:rag123@localhost:5432/rag"
    python refresh_embeddings.py
"""
import os
import sys
import json
import time
import urllib.request
import psycopg2

# ── 配置 ─────────────────────────────────────────────────────
API_KEY = os.environ.get("OPENAI_API_KEY", "")
BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
MODEL = os.environ.get("LIGHTRAG_EMBEDDING_MODEL", "BAAI/bge-m3")
DB_CONN = os.environ.get("RAG_DB_CONN_STR", "")

BATCH_SIZE = 16  # 每批处理的文本数


def call_embedding_api(texts: list) -> list:
    """调用 OpenAI 兼容 API 批量生成 embedding"""
    url = f"{BASE_URL}/embeddings"
    payload = json.dumps({"input": texts, "model": MODEL}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    # 按 index 排序确保顺序正确
    embeddings = sorted(data["data"], key=lambda x: x["index"])
    return [item["embedding"] for item in embeddings]


def parse_conn_str(conn_str: str) -> dict:
    """解析 postgres://user:pass@host:port/db 格式连接串"""
    # 支持 postgres:rag123@localhost:5432/rag 格式
    if conn_str.startswith("postgres://"):
        conn_str = conn_str[len("postgres://"):]
    elif "://" in conn_str:
        conn_str = conn_str.split("://", 1)[1]
    
    user_pass, rest = conn_str.split("@", 1)
    if ":" in user_pass:
        user, password = user_pass.split(":", 1)
    else:
        user, password = user_pass, ""
    
    host_port, dbname = rest.split("/", 1)
    if ":" in host_port:
        host, port = host_port.split(":", 1)
    else:
        host, port = host_port, "5432"
    
    return {"host": host, "port": port, "dbname": dbname, "user": user, "password": password}


def main():
    if not API_KEY:
        print("ERROR: OPENAI_API_KEY 未设置")
        sys.exit(1)
    if not DB_CONN:
        print("ERROR: RAG_DB_CONN_STR 未设置")
        sys.exit(1)

    params = parse_conn_str(DB_CONN)
    conn = psycopg2.connect(**params)
    conn.autocommit = False

    print(f"已连接数据库: {params['dbname']}")
    print(f"Embedding 模型: {MODEL} ({BASE_URL})")
    print()

    cur = conn.cursor()

    # ── 1. 刷新 rag_passage ──
    print("=== 刷新 rag_passage embedding ===")
    cur.execute("SELECT id, content FROM data.rag_passage WHERE content IS NOT NULL ORDER BY id")
    passages = cur.fetchall()
    print(f"  共 {len(passages)} 条段落需要刷新")

    updated = 0
    for i in range(0, len(passages), BATCH_SIZE):
        batch = passages[i:i + BATCH_SIZE]
        texts = [p[1] for p in batch]
        ids = [p[0] for p in batch]

        try:
            embeddings = call_embedding_api(texts)
            for pid, emb in zip(ids, embeddings):
                cur.execute(
                    "UPDATE data.rag_passage SET embedding = %s::vector WHERE id = %s",
                    (str(emb), pid)
                )
            conn.commit()
            updated += len(batch)
            print(f"  [{updated}/{len(passages)}] 已刷新", end="\r")
        except Exception as e:
            print(f"\n  [ERROR] batch {i//BATCH_SIZE}: {e}")
            conn.rollback()

        # 限流：硅基流动 RPM 限制
        if i + BATCH_SIZE < len(passages):
            time.sleep(0.5)

    print(f"\n  rag_passage 刷新完成: {updated} 条")

    # ── 2. 刷新 rag_verify ──
    print("\n=== 刷新 rag_verify embedding ===")
    cur.execute("SELECT id, txt FROM data.rag_verify WHERE txt IS NOT NULL ORDER BY id")
    verifies = cur.fetchall()
    print(f"  共 {len(verifies)} 条需要刷新")

    updated = 0
    for i in range(0, len(verifies), BATCH_SIZE):
        batch = verifies[i:i + BATCH_SIZE]
        texts = [v[1] for v in batch]
        ids = [v[0] for v in batch]

        try:
            embeddings = call_embedding_api(texts)
            for vid, emb in zip(ids, embeddings):
                cur.execute(
                    "UPDATE data.rag_verify SET embedding = %s::vector WHERE id = %s",
                    (str(emb), vid)
                )
            conn.commit()
            updated += len(batch)
            print(f"  [{updated}/{len(verifies)}] 已刷新", end="\r")
        except Exception as e:
            print(f"\n  [ERROR] batch {i//BATCH_SIZE}: {e}")
            conn.rollback()

        if i + BATCH_SIZE < len(verifies):
            time.sleep(0.5)

    print(f"\n  rag_verify 刷新完成: {updated} 条")

    cur.close()
    conn.close()
    print("\n=== 全部完成 ===")


if __name__ == "__main__":
    main()
