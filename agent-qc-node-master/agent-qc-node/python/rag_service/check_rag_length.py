"""检查 RAG 搜索结果的内容长度和密度"""
import requests
import json
import sys

# 确保输出编码正确
sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://localhost:8100"

def check_pageindex_search(query_text, doc_ids, label):
    print(f"\n{'='*70}")
    print(f"[{label}] query={query_text}, doc_ids={doc_ids}")
    print(f"{'='*70}")
    r = requests.post(f"{BASE}/rag_pageindex_search", json={
        "query_text": query_text,
        "doc_ids": doc_ids
    })
    data = r.json()
    results = data if isinstance(data, list) else data.get("results", [])
    print(f"命中 {len(results)} 条")
    total_chars = 0
    for i, x in enumerate(results):
        content = x.get("txt", x.get("content", x.get("text", "")))
        path = x.get("section_path", x.get("file_path", "?"))
        sim = x.get("similarity", x.get("sim", "?"))
        source = x.get("source", "?")
        char_count = len(content)
        total_chars += char_count
        print(f"\n  [{i+1}] source={source} sim={sim} chars={char_count}")
        print(f"      path={path}")
        # 显示前200字
        preview = content[:200].replace('\n', ' ')
        print(f"      预览: {preview}...")
    print(f"\n  --- 总计 {len(results)} 条, {total_chars} 字 ---")

def check_lightrag_search(query_text, doc_ids, label):
    print(f"\n{'='*70}")
    print(f"[LightRAG {label}] query={query_text}, doc_ids={doc_ids}")
    print(f"{'='*70}")
    r = requests.post(f"{BASE}/rag_lightrag_search", json={
        "query_text": query_text,
        "doc_ids": doc_ids
    })
    data = r.json()
    results = data if isinstance(data, list) else data.get("results", [])
    print(f"命中 {len(results)} 条")
    total_chars = 0
    for i, x in enumerate(results):
        content = x.get("txt", x.get("content", x.get("text", "")))
        path = x.get("section_path", x.get("file_path", "?"))
        sim = x.get("similarity", x.get("sim", "?"))
        source = x.get("source", "?")
        char_count = len(content)
        total_chars += char_count
        print(f"\n  [{i+1}] source={source} sim={sim} chars={char_count}")
        print(f"      path={path}")
        # 显示前200字
        preview = content[:200].replace('\n', ' ')
        print(f"      预览: {preview}...")
    print(f"\n  --- 总计 {len(results)} 条, {total_chars} 字 ---")

# 测试几个典型场景
print("\n" + "="*70)
print("PageIndex 向量搜索结果")
print("="*70)
check_pageindex_search("肺炎诊断标准", [210, 285], "A004 肺炎")
check_pageindex_search("抗菌药物分级", [270, 271, 273], "B001 抗菌药")

print("\n" + "="*70)
print("LightRAG 图谱搜索结果")
print("="*70)
check_lightrag_search("肺炎诊断标准", [210, 285], "A004 肺炎")
check_lightrag_search("抗菌药物分级", [270, 271, 273], "B001 抗菌药")
