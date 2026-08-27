"""
direct_sync_lightrag.py - 直接调用 LightRAG 实例批量插入（绕过 HTTP API）
在同一个事件循环中运行，避免 event loop 冲突

用法:
    $env:OPENAI_API_KEY="sk-xxx"
    $env:OPENAI_BASE_URL="https://api.siliconflow.cn/v1"
    $env:LIGHTRAG_LLM_MODEL="deepseek-ai/DeepSeek-V3"
    $env:LIGHTRAG_EMBEDDING_MODEL="BAAI/bge-m3"
    $env:LIGHTRAG_EMBEDDING_DIM="1024"
    $env:RAG_DB_CONN_STR="postgres:rag123@localhost:5432/rag"
    python direct_sync_lightrag.py
"""
import os
import sys
import json
import asyncio
import psycopg2

# ── 配置 ─────────────────────────────────────────────────────
DB_CONN = os.environ.get("RAG_DB_CONN_STR", "")

# 需要同步的 doc_id 列表
SYNC_DOC_IDS = [
    210, 211, 212, 220, 221, 222, 230, 250,
    260, 261, 270, 271, 273, 280, 281, 282, 285,
]


def get_db_conn():
    """解析连接字符串"""
    conn_str = DB_CONN
    if conn_str.startswith("postgres:"):
        conn_str = conn_str[len("postgres:"):]
    at_idx = conn_str.index("@")
    password = conn_str[:at_idx]
    rest = conn_str[at_idx+1:]
    slash_idx = rest.index("/")
    host_port = rest[:slash_idx]
    dbname = rest[slash_idx+1:]
    colon_idx = host_port.index(":")
    host = host_port[:colon_idx]
    port = int(host_port[colon_idx+1:])
    return psycopg2.connect(
        host=host, port=port, dbname=dbname, user="postgres", password=password
    )


def get_doc_info(conn, doc_id):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT title, node_path FROM data.rag_source_doc WHERE id = %s",
            (doc_id,)
        )
        row = cur.fetchone()
        if row:
            return {"title": row[0], "node_path": row[1] or ""}
    return None


def get_passages(conn, doc_id):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT content FROM data.rag_passage WHERE doc_id = %s AND enabled = true ORDER BY id",
            (doc_id,)
        )
        return [r[0] for r in cur.fetchall()]


async def main():
    if not DB_CONN:
        print("[ERROR] 请设置 RAG_DB_CONN_STR")
        sys.exit(1)

    # 导入并初始化 LightRAG
    from lightrag_search import _get_lightrag_instance, _doc_mapping, _save_doc_mapping
    
    rag = _get_lightrag_instance()
    if rag is None:
        print("[ERROR] LightRAG 初始化失败")
        sys.exit(1)
    
    print(f"[OK] LightRAG 已初始化, working_dir={rag.working_dir}")
    
    conn = get_db_conn()
    
    print("=" * 60)
    print("  直接同步书籍到 LightRAG（同一事件循环）")
    print("=" * 60)
    
    success_count = 0
    fail_count = 0
    
    for doc_id in SYNC_DOC_IDS:
        doc_info = get_doc_info(conn, doc_id)
        if not doc_info:
            print(f"  [SKIP] doc_id={doc_id} 不存在")
            continue
        
        passages = get_passages(conn, doc_id)
        if not passages:
            print(f"  [SKIP] doc_id={doc_id} {doc_info['title']} 无段落")
            continue
        
        text = "\n\n".join(passages)
        file_path = doc_info["node_path"] or doc_info["title"]
        
        print(f"  [SYNC] doc_id={doc_id} {doc_info['title']} ({len(passages)} 段落, {len(text)} 字)")
        
        try:
            # 直接调用 ainsert，在同一事件循环中
            await rag.ainsert(text, file_paths=[file_path])
            print(f"    -> OK")
            
            # 查找刚插入的文档 ID
            full_docs_path = os.path.join(rag.working_dir, "kv_store_full_docs.json")
            lightrag_doc_id = None
            if os.path.exists(full_docs_path):
                with open(full_docs_path, 'r', encoding='utf-8') as f:
                    full_docs = json.load(f)
                for did, doc_data in full_docs.items():
                    if doc_data.get("file_path") == file_path:
                        lightrag_doc_id = did
                        break
                if not lightrag_doc_id and full_docs:
                    lightrag_doc_id = list(full_docs.keys())[-1]
            
            _doc_mapping[str(doc_id)] = {
                "file_path": file_path,
                "lightrag_doc_id": lightrag_doc_id,
            }
            
            success_count += 1
        except Exception as e:
            print(f"    -> FAILED: {e}")
            fail_count += 1
    
    # 保存映射
    _save_doc_mapping()
    conn.close()
    
    print()
    print(f"  同步完成: 成功 {success_count}, 失败 {fail_count}")
    print(f"  映射表共 {_doc_mapping.__len__()} 条")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
