"""测试编码规则搜索"""
import requests
import sys
sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://localhost:8100"

# 测试1: 肺炎合并COPD编码
print("=" * 60)
print("测试1: 肺炎合并COPD怎么编码")
print("=" * 60)
r = requests.post(f"{BASE}/rag_pageindex_search", json={
    "query_text": "肺炎合并COPD怎么编码",
    "doc_ids": [301, 302]
})
data = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
print(f"命中 {len(data)} 条")
for i, x in enumerate(data[:3]):
    path = x.get("section_path", "?")
    content = x.get("txt", x.get("content", ""))[:80]
    print(f"  [{i+1}] {path}")
    print(f"      {content}...")

# 测试2: 主要诊断选择原则
print("\n" + "=" * 60)
print("测试2: 主要诊断应该选哪个")
print("=" * 60)
r = requests.post(f"{BASE}/rag_pageindex_search", json={
    "query_text": "主要诊断应该选哪个",
    "doc_ids": [301, 302]
})
data = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
print(f"命中 {len(data)} 条")
for i, x in enumerate(data[:3]):
    path = x.get("section_path", "?")
    content = x.get("txt", x.get("content", ""))[:80]
    print(f"  [{i+1}] {path}")
    print(f"      {content}...")

# 测试3: 冠心病合并心梗
print("\n" + "=" * 60)
print("测试3: 冠心病合并急性心梗怎么编码")
print("=" * 60)
r = requests.post(f"{BASE}/rag_pageindex_search", json={
    "query_text": "冠心病合并急性心梗怎么编码",
    "doc_ids": [301, 302]
})
data = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
print(f"命中 {len(data)} 条")
for i, x in enumerate(data[:3]):
    path = x.get("section_path", "?")
    content = x.get("txt", x.get("content", ""))[:80]
    print(f"  [{i+1}] {path}")
    print(f"      {content}...")

print("\n" + "=" * 60)
print("编码规则知识补充完成！")
print("=" * 60)
