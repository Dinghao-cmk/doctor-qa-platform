"""测试 PageIndex 联动：插入两篇文档，按 doc_ids 过滤检索"""
import requests
import json
import time
import sys
import io

# 修复 Windows GBK 编码问题
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

BASE = "http://localhost:8100"

# ── Step 1: 插入两篇不同 doc_id 的文档 ──
print("=== 插入文档 doc_id=1 (高血压) ===")
r1 = requests.post(f"{BASE}/rag_lightrag_insert", json={
    "document_text": "高血压是最常见的心血管疾病之一，治疗包括生活方式干预和药物治疗。生活方式干预包括低盐饮食、适量运动、控制体重、戒烟限酒。常用降压药物包括钙通道阻滞剂（如硝苯地平）、血管紧张素转换酶抑制剂（如依那普利）、利尿剂（如氢氯噻嗪）等。",
    "doc_id": 1,
    "file_path": "心血管/高血压",
}, timeout=120)
print(f"  结果: {r1.json()}")

print("\n=== 插入文档 doc_id=2 (糖尿病) ===")
r2 = requests.post(f"{BASE}/rag_lightrag_insert", json={
    "document_text": "糖尿病是一种慢性代谢性疾病，主要特征是血糖升高。治疗包括饮食控制、运动和降糖药物。常用降糖药物包括二甲双胍、磺脲类（如格列本脲）、胰岛素等。糖尿病患者需定期监测血糖，控制饮食中的碳水化合物摄入。",
    "doc_id": 2,
    "file_path": "内分泌/糖尿病",
}, timeout=120)
print(f"  结果: {r2.json()}")

# 等待索引稳定
time.sleep(2)

# ── Step 2: 不限 doc_ids 搜索 ──
print("\n=== 搜索: '血糖高怎么治疗' (不限 doc_ids) ===")
r3 = requests.post(f"{BASE}/rag_lightrag_search", json={
    "query_text": "血糖高怎么治疗",
    "mode": "hybrid",
    "limit_count": 5,
}, timeout=60)
results_all = r3.json()
print(f"  返回 {len(results_all)} 条结果")
for i, r in enumerate(results_all):
    txt_preview = r.get("txt", "")[:80]
    section = r.get("section_path", "-")
    print(f"  [{i+1}] section_path={section} | {txt_preview}...")

# ── Step 3: 限定 doc_ids=[1] (只有高血压) ──
print("\n=== 搜索: '血糖高怎么治疗' doc_ids=[1] (仅心血管/高血压) ===")
r4 = requests.post(f"{BASE}/rag_lightrag_search", json={
    "query_text": "血糖高怎么治疗",
    "mode": "hybrid",
    "limit_count": 5,
    "doc_ids": [1],
}, timeout=60)
results_doc1 = r4.json()
print(f"  返回 {len(results_doc1)} 条结果")
for i, r in enumerate(results_doc1):
    txt_preview = r.get("txt", "")[:80]
    section = r.get("section_path", "-")
    print(f"  [{i+1}] section_path={section} | {txt_preview}...")

# ── Step 4: 限定 doc_ids=[2] (只有糖尿病) ──
print("\n=== 搜索: '血糖高怎么治疗' doc_ids=[2] (仅内分泌/糖尿病) ===")
r5 = requests.post(f"{BASE}/rag_lightrag_search", json={
    "query_text": "血糖高怎么治疗",
    "mode": "hybrid",
    "limit_count": 5,
    "doc_ids": [2],
}, timeout=60)
results_doc2 = r5.json()
print(f"  返回 {len(results_doc2)} 条结果")
for i, r in enumerate(results_doc2):
    txt_preview = r.get("txt", "")[:80]
    section = r.get("section_path", "-")
    print(f"  [{i+1}] section_path={section} | {txt_preview}...")

# ── 验证 ──
print("\n=== 验证 ===")
has_doc1_only = all(r.get("section_path") == "心血管/高血压" for r in results_doc1 if r.get("section_path"))
has_doc2_only = all(r.get("section_path") == "内分泌/糖尿病" for r in results_doc2 if r.get("section_path"))
print(f"  doc_ids=[1] 只返回高血压内容: {'PASS' if has_doc1_only and len(results_doc1) > 0 else 'FAIL'}")
print(f"  doc_ids=[2] 只返回糖尿病内容: {'PASS' if has_doc2_only and len(results_doc2) > 0 else 'FAIL'}")

# 保存完整结果供查看
with open("test_linkage_result.json", "w", encoding="utf-8") as f:
    json.dump({
        "all_docs": results_all,
        "doc_ids_1": results_doc1,
        "doc_ids_2": results_doc2,
    }, f, ensure_ascii=False, indent=2)
print(f"\n完整结果已保存到 test_linkage_result.json")
