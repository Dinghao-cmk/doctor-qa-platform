"""调试 doc_id 过滤"""
import requests
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://localhost:8100"

# 测试：只查 J18 肺炎
print("测试1: 只查 doc_id=210 (J18 肺炎)")
r = requests.post(f"{BASE}/rag_lightrag_search", json={
    "query_text": "肺炎诊断标准",
    "doc_ids": [210]
})
results = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
print(f"命中 {len(results)} 条")
for i, x in enumerate(results):
    print(f"  [{i+1}] path={x.get('section_path')} chars={len(x.get('txt', ''))}")
    print(f"      {x.get('txt', '')[:100]}...")

# 测试：只查胸部CT
print("\n测试2: 只查 doc_id=285 (胸部CT)")
r = requests.post(f"{BASE}/rag_lightrag_search", json={
    "query_text": "肺炎诊断标准",
    "doc_ids": [285]
})
results = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
print(f"命中 {len(results)} 条")
for i, x in enumerate(results):
    print(f"  [{i+1}] path={x.get('section_path')} chars={len(x.get('txt', ''))}")

# 检查映射文件
print("\n检查映射文件:")
with open('./lightrag_data/doc_id_mapping.json', 'r', encoding='utf-8') as f:
    mapping = json.load(f)
print(f"  210 -> {mapping.get('210', '?')}")
print(f"  285 -> {mapping.get('285', '?')}")

# 检查 text_chunks 中 J18 的块
print("\n检查 J18 的 text_chunks:")
with open('./lightrag_data/kv_store_text_chunks.json', 'r', encoding='utf-8') as f:
    chunks = json.load(f)
j18_id = "doc-90fa44500bccd427737678c4f12ce717"
j18_chunks = [c for c in chunks.values() if c.get("full_doc_id") == j18_id]
print(f"  J18 共 {len(j18_chunks)} 个 chunks")
for i, c in enumerate(j18_chunks[:2]):
    print(f"  [{i+1}] {c.get('content', '')[:80]}...")
