"""测试 PageIndex 向量搜索 - 查看实际路径"""
import requests
import sys
sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://localhost:8100"

# 测试肺炎诊断
r = requests.post(f"{BASE}/rag_pageindex_search", json={
    "query_text": "肺炎诊断标准",
    "doc_ids": [210],
    "similarity_threshold": 0.3
})
data = r.json()
print(f"Results: {len(data)}")
for i, x in enumerate(data[:3]):
    path = x.get("section_path", "?")
    print(f"  [{i+1}] path={path}")
    # 检查是否包含 J18
    if "J18" in path:
        print(f"      ✓ 包含 J18")
    else:
        print(f"      ✗ 不包含 J18")
