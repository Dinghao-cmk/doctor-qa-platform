"""只测试 PageIndex"""
import requests
import sys

sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://localhost:8100"

TEST_CASES = [
    ("肺炎诊断标准", [210, 285], ["J18"], "A004 肺炎诊断"),
    ("肺炎病原体", [210, 285], ["J18"], "A004 肺炎病原体"),
    ("肺炎影像学检查", [210, 285], ["J18"], "A004 肺炎影像"),
    ("抗菌药物分级管理", [270, 271, 273], ["抗菌药物"], "B001 抗菌药分级"),
    ("社区获得性肺炎经验用药", [270, 271, 273], ["肺部"], "B001 经验用药"),
    ("冠心病诊断", [220], ["I25"], "冠心病诊断"),
    ("冠心病治疗", [220], ["I25"], "冠心病治疗"),
    ("高血压诊断标准", [222, 260, 261], ["I10", "标准"], "高血压诊断"),
    ("降压药物选择", [222, 260, 261], ["选择"], "高血压用药"),
    ("胃溃疡诊断", [230], ["K25"], "胃溃疡诊断"),
    ("心力衰竭治疗", [221], ["I50"], "心衰治疗"),
    ("急性阑尾炎诊断", [250], ["K35"], "阑尾炎诊断"),
    ("发热病因", [280], ["发热"], "发热病因"),
    ("胸痛鉴别", [282], ["胸痛"], "胸痛鉴别"),
    ("胸部CT适应证", [285], ["胸部CT"], "胸部CT适应证"),
]

pi_pass = 0
pi_fail = 0
pi_details = []

for query, doc_ids, keywords, label in TEST_CASES:
    try:
        r = requests.post(f"{BASE}/rag_pageindex_search", json={
            "query_text": query,
            "doc_ids": doc_ids,
            "similarity_threshold": 0.3
        }, timeout=30)
        results = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
        
        if not results:
            ok, msg = False, "无结果"
        else:
            found = False
            for kw in keywords:
                for res in results:
                    path = res.get("section_path", "")
                    if kw in path:
                        found = True
                        break
                if found:
                    break
            
            if found:
                ok, msg = True, f"命中 {kw}"
            else:
                paths = [res.get("section_path", "?")[:40] for res in results[:3]]
                ok, msg = False, f"路径不匹配: {paths}"
    except Exception as e:
        ok, msg = False, f"错误: {e}"
    
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

if pi_details:
    print(f"\n失败场景:")
    for label, msg in pi_details:
        print(f"  - {label}: {msg}")
