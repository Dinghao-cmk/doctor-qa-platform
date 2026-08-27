"""测试组合 doc_id 查询"""
import requests
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://localhost:8100"

print("测试: doc_ids=[210, 285] (J18 肺炎 + 胸部CT)")
r = requests.post(f"{BASE}/rag_lightrag_search", json={
    "query_text": "肺炎诊断标准",
    "doc_ids": [210, 285]
})
results = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
print(f"命中 {len(results)} 条")
for i, x in enumerate(results):
    print(f"  [{i+1}] path={x.get('section_path')} chars={len(x.get('txt', ''))}")
    print(f"      {x.get('txt', '')[:80]}...")
