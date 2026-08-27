"""
sync_to_lightrag.py - 将 PageIndex 路由涉及的书籍同步灌入 LightRAG
读取 rag_passage 表中的段落内容，合并后通过 API 插入 LightRAG

用法:
    $env:RAG_DB_CONN_STR="postgres:rag123@localhost:5432/rag"
    $env:RAG_SERVER_ROOT="http://localhost:8100"
    python sync_to_lightrag.py
"""
import os
import sys
import json
import urllib.request
import psycopg2

# ── 配置 ─────────────────────────────────────────────────────
DB_CONN = os.environ.get("RAG_DB_CONN_STR", "")
RAG_SERVER = os.environ.get("RAG_SERVER_ROOT", "http://localhost:8100")

# 需要同步的 doc_id 列表（PageIndex 路由涉及的关键书籍）
SYNC_DOC_IDS = [
    210,  # J18 肺炎
    211,  # J44 COPD
    212,  # J45 支气管哮喘
    220,  # I25 冠心病
    221,  # I50 心力衰竭
    222,  # I10 高血压
    230,  # K25 胃溃疡
    250,  # K35 急性阑尾炎
    260,  # 高血压诊断标准
    261,  # 降压药物选择
    270,  # 非限制级抗菌药物
    271,  # 限制级抗菌药物
    273,  # 肺部感染经验用药
    280,  # 发热
    281,  # 咳嗽与咳痰
    282,  # 胸痛
    285,  # 胸部CT
]


def get_db_conn():
    """解析连接字符串"""
    # 格式: postgres:password@host:port/dbname
    # 例: postgres:rag123@localhost:5432/rag
    conn_str = DB_CONN
    if conn_str.startswith("postgres:"):
        conn_str = conn_str[len("postgres:"):]
    # 现在 conn_str = "rag123@localhost:5432/rag"
    
    at_idx = conn_str.index("@")
    password = conn_str[:at_idx]
    rest = conn_str[at_idx+1:]
    # rest = "localhost:5432/rag"
    
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
    """获取文档标题和路径"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT title, file_path, node_path FROM data.rag_source_doc WHERE id = %s",
            (doc_id,)
        )
        row = cur.fetchone()
        if row:
            return {"title": row[0], "file_path": row[1] or "", "node_path": row[2] or ""}
    return None


def get_passages(conn, doc_id):
    """获取文档下的所有段落"""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, content FROM data.rag_passage WHERE doc_id = %s AND enabled = true ORDER BY id",
            (doc_id,)
        )
        return [{"id": r[0], "content": r[1]} for r in cur.fetchall()]


def insert_to_lightrag(doc_id, file_path, text):
    """调用 LightRAG API 插入文档"""
    url = f"{RAG_SERVER}/rag_lightrag_insert"
    payload = json.dumps({
        "document_text": text,
        "doc_id": doc_id,
        "file_path": file_path,
    }).encode("utf-8")
    
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result.get("success", False)
    except Exception as e:
        print(f"  [ERROR] API 调用失败: {e}")
        return False


def main():
    if not DB_CONN:
        print("[ERROR] 请设置 RAG_DB_CONN_STR 环境变量")
        sys.exit(1)
    
    conn = get_db_conn()
    
    print("=" * 60)
    print("  同步书籍到 LightRAG")
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
        
        # 合并段落内容
        text = "\n\n".join(p["content"] for p in passages)
        file_path = doc_info["node_path"] or doc_info["file_path"] or doc_info["title"]
        
        print(f"  [SYNC] doc_id={doc_id} {doc_info['title']} ({len(passages)} 段落, {len(text)} 字)")
        
        ok = insert_to_lightrag(doc_id, file_path, text)
        if ok:
            print(f"    -> OK")
            success_count += 1
        else:
            print(f"    -> FAILED")
            fail_count += 1
    
    conn.close()
    
    print()
    print(f"  同步完成: 成功 {success_count}, 失败 {fail_count}")
    print("=" * 60)


if __name__ == "__main__":
    main()
