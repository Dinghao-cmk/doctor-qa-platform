"""RAG 全场景准确率测试"""
import requests
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://localhost:8100"

# 测试用例：(query, doc_ids, 期望命中的 section_path 关键词, 场景描述)
TEST_CASES = [
    # A004 肺炎 - PageIndex 路由到 J18 + 胸部CT
    ("肺炎诊断标准", [210, 285], ["J18"], "A004 肺炎诊断"),
    ("肺炎病原体", [210, 285], ["J18"], "A004 肺炎病原体"),
    ("肺炎影像学检查", [210, 285], ["J18"], "A004 肺炎影像"),
    
    # B001 抗菌药 - PageIndex 路由到 非限制 + 限制 + 肺部经验用药
    ("抗菌药物分级管理", [270, 271, 273], ["抗菌药物"], "B001 抗菌药分级"),
    ("社区获得性肺炎经验用药", [270, 271, 273], ["肺部"], "B001 经验用药"),
    
    # 冠心病 - PageIndex 路由到 I25
    ("冠心病诊断", [220], ["I25"], "冠心病诊断"),
    ("冠心病治疗", [220], ["I25"], "冠心病治疗"),
    
    # 高血压 - PageIndex 路由到 I10 + 标准 + 选择
    ("高血压诊断标准", [222, 260, 261], ["I10", "标准"], "高血压诊断"),
    ("降压药物选择", [222, 260, 261], ["选择"], "高血压用药"),
    
    # 胃溃疡 - PageIndex 路由到 K25
    ("胃溃疡诊断", [230], ["K25"], "胃溃疡诊断"),
    
    # 心力衰竭 - PageIndex 路由到 I50
    ("心力衰竭治疗", [221], ["I50"], "心衰治疗"),
    
    # 急性阑尾炎 - PageIndex 路由到 K35
    ("急性阑尾炎诊断", [250], ["K35"], "阑尾炎诊断"),
    
    # 发热 - PageIndex 路由到 发热
    ("发热病因", [280], ["发热"], "发热病因"),
    
    # 胸痛 - PageIndex 路由到 胸痛
    ("胸痛鉴别", [282], ["胸痛"], "胸痛鉴别"),
    
    # 胸部CT - PageIndex 路由到 胸部CT
    ("胸部CT适应证", [285], ["胸部CT"], "胸部CT适应证"),
]

def test_pageindex(query, doc_ids, expected_keywords, label):
    """测试 PageIndex 向量搜索"""
    r = requests.post(f"{BASE}/rag_pageindex_search", json={
        "query_text": query,
        "doc_ids": doc_ids,
        "similarity_threshold": 0.3
    })
    results = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
    
    if not results:
        return False, "无结果"
    
    # 检查是否命中期望的路径
    for kw in expected_keywords:
        for res in results:
            path = res.get("section_path", "")
            if kw in path:
                return True, f"命中 {kw}"
    
    paths = [res.get("section_path", "?") for res in results]
    return False, f"路径不匹配: {paths}"

def test_lightrag(query, doc_ids, expected_keywords, label):
    """测试 LightRAG 图谱搜索"""
    r = requests.post(f"{BASE}/rag_lightrag_search", json={
        "query_text": query,
        "doc_ids": doc_ids
    })
    results = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
    
    if not results:
        return False, "无结果"
    
    # 检查是否命中期望的路径
    for kw in expected_keywords:
        for res in results:
            path = res.get("section_path", "")
            if kw in path:
                return True, f"命中 {kw}"
    
    paths = [res.get("section_path", "?") for res in results]
    return False, f"路径不匹配: {paths}"

# 运行测试
print("=" * 70)
print("PageIndex 向量搜索准确率测试")
print("=" * 70)

pi_pass = 0
pi_fail = 0
pi_details = []

for query, doc_ids, keywords, label in TEST_CASES:
    ok, msg = test_pageindex(query, doc_ids, keywords, label)
    status = "✓" if ok else "✗"
    print(f"  {status} [{label}] {msg}")
    if ok:
        pi_pass += 1
    else:
        pi_fail += 1
        pi_details.append((label, msg))

pi_total = pi_pass + pi_fail
pi_rate = pi_pass / pi_total * 100 if pi_total > 0 else 0
print(f"\nPageIndex: {pi_pass}/{pi_total} 通过, 准确率 {pi_rate:.1f}%")

print("\n" + "=" * 70)
print("LightRAG 图谱搜索准确率测试")
print("=" * 70)

lr_pass = 0
lr_fail = 0
lr_details = []

for query, doc_ids, keywords, label in TEST_CASES:
    ok, msg = test_lightrag(query, doc_ids, keywords, label)
    status = "✓" if ok else "✗"
    print(f"  {status} [{label}] {msg}")
    if ok:
        lr_pass += 1
    else:
        lr_fail += 1
        lr_details.append((label, msg))

lr_total = lr_pass + lr_fail
lr_rate = lr_pass / lr_total * 100 if lr_total > 0 else 0
print(f"\nLightRAG: {lr_pass}/{lr_total} 通过, 准确率 {lr_rate:.1f}%")

print("\n" + "=" * 70)
print("汇总")
print("=" * 70)
print(f"PageIndex 向量搜索: {pi_rate:.1f}% ({pi_pass}/{pi_total})")
print(f"LightRAG 图谱搜索:  {lr_rate:.1f}% ({lr_pass}/{lr_total})")

if pi_details:
    print(f"\nPageIndex 失败场景:")
    for label, msg in pi_details:
        print(f"  - {label}: {msg}")

if lr_details:
    print(f"\nLightRAG 失败场景:")
    for label, msg in lr_details:
        print(f"  - {label}: {msg}")
