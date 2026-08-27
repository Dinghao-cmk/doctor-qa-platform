"""验证 LightRAG 同步后的搜索效果"""
import requests
import json

BASE = "http://localhost:8100"

def test_lightrag(query, doc_ids, label):
    print(f"\n{'='*60}")
    print(f"[{label}] query={query}, doc_ids={doc_ids}")
    print(f"{'='*60}")
    r = requests.post(f"{BASE}/rag_lightrag_search", json={
        "query_text": query,
        "doc_ids": doc_ids
    })
    data = r.json()
    results = data if isinstance(data, list) else data.get("results", [])
    print(f"命中 {len(results)} 条")
    for i, x in enumerate(results[:5]):
        path = x.get("file_path", "?")[:50]
        sim = x.get("sim", "?")
        content = x.get("content", "")[:80]
        print(f"  [{i+1}] sim={sim} path={path}")
        print(f"      {content}...")

# A004 肺炎
test_lightrag("肺炎诊断标准", [210, 285], "A004 肺炎")

# B001 抗菌药
test_lightrag("抗菌药物分级管理", [270, 271, 273], "B001 抗菌药")

# 冠心病
test_lightrag("冠心病诊断标准", [220], "冠心病")

# 胸痛
test_lightrag("胸痛鉴别诊断", [282], "胸痛")

print("\n" + "="*60)
print("验证完成!")
