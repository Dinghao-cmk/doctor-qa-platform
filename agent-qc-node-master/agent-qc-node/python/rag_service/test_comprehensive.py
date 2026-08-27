"""RAG 服务完整测试套件
覆盖：健康检查、PageIndex、LightRAG、Verify、边界情况、数据完整性
"""
import requests
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://localhost:8100"
TIMEOUT = 30

# ── 统计 ──────────────────────────────────────────────────
class Stats:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors = []
    
    def ok(self, name):
        self.passed += 1
        print(f"  ✓ {name}")
    
    def fail(self, name, msg=""):
        self.failed += 1
        self.errors.append((name, msg))
        print(f"  ✗ {name}: {msg}")
    
    def summary(self, title):
        total = self.passed + self.failed
        rate = self.passed / total * 100 if total > 0 else 0
        print(f"\n{title}: {self.passed}/{total} 通过 ({rate:.1f}%)")
        return rate

stats = Stats()

# ── 1. 健康检查 ───────────────────────────────────────────
print("=" * 70)
print("1. 健康检查")
print("=" * 70)

try:
    r = requests.get(f"{BASE}/health", timeout=TIMEOUT)
    data = r.json()
    if r.status_code == 200 and data.get("status") == "ok":
        stats.ok(f"服务健康 (db={data.get('database')}, verify={data.get('rag_verify_count')})")
    else:
        stats.fail("服务健康", f"status={data.get('status')}")
except Exception as e:
    stats.fail("服务健康", str(e))

try:
    r = requests.get(f"{BASE}/lightrag_health", timeout=TIMEOUT)
    data = r.json()
    if r.status_code == 200 and data.get("status") == "ok":
        stats.ok(f"LightRAG 健康 (docs={data.get('doc_count')})")
    else:
        stats.fail("LightRAG 健康", f"status={data.get('status')}")
except Exception as e:
    stats.fail("LightRAG 健康", str(e))

# ── 2. PageIndex 向量搜索 ─────────────────────────────────
print("\n" + "=" * 70)
print("2. PageIndex 向量搜索")
print("=" * 70)

PAGEINDEX_CASES = [
    ("肺炎诊断标准", [210, 285], ["J18"], "肺炎→J18"),
    ("抗菌药物分级管理", [270, 271, 273], ["抗菌药物"], "抗菌药→抗菌药物"),
    ("冠心病诊断", [220], ["I25"], "冠心病→I25"),
    ("高血压诊断标准", [222, 260, 261], ["I10", "标准"], "高血压→I10"),
    ("胃溃疡诊断", [230], ["K25"], "胃溃疡→K25"),
    ("心力衰竭治疗", [221], ["I50"], "心衰→I50"),
    ("急性阑尾炎诊断", [250], ["K35"], "阑尾炎→K35"),
    ("发热病因", [280], ["发热"], "发热→发热"),
    ("胸痛鉴别", [282], ["胸痛"], "胸痛→胸痛"),
    ("胸部CT适应证", [285], ["胸部CT"], "CT→胸部CT"),
]

for query, doc_ids, keywords, label in PAGEINDEX_CASES:
    try:
        r = requests.post(f"{BASE}/rag_pageindex_search", json={
            "query_text": query,
            "doc_ids": doc_ids,
            "similarity_threshold": 0.3
        }, timeout=TIMEOUT)
        results = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
        
        if not results:
            stats.fail(f"PageIndex {label}", "无结果")
            continue
        
        found = any(kw in res.get("section_path", "") for kw in keywords for res in results)
        if found:
            stats.ok(f"PageIndex {label}")
        else:
            paths = [res.get("section_path", "?")[:20] for res in results[:2]]
            stats.fail(f"PageIndex {label}", f"路径不匹配: {paths}")
    except Exception as e:
        stats.fail(f"PageIndex {label}", str(e))

# ── 3. LightRAG 图谱搜索 ─────────────────────────────────
print("\n" + "=" * 70)
print("3. LightRAG 图谱搜索")
print("=" * 70)

LIGHTRAG_CASES = [
    ("肺炎诊断标准", [210, 285], ["J18"], "肺炎→J18"),
    ("抗菌药物分级管理", [270, 271, 273], ["抗菌药物"], "抗菌药→抗菌药物"),
    ("冠心病诊断", [220], ["I25"], "冠心病→I25"),
    ("高血压诊断标准", [222, 260, 261], ["I10", "标准"], "高血压→I10"),
    ("胃溃疡诊断", [230], ["K25"], "胃溃疡→K25"),
]

for query, doc_ids, keywords, label in LIGHTRAG_CASES:
    try:
        r = requests.post(f"{BASE}/rag_lightrag_search", json={
            "query_text": query,
            "doc_ids": doc_ids,
            "mode": "hybrid"
        }, timeout=TIMEOUT)
        results = r.json() if isinstance(r.json(), list) else r.json().get("results", [])
        
        if not results:
            stats.fail(f"LightRAG {label}", "无结果")
            continue
        
        found = any(kw in res.get("section_path", "") for kw in keywords for res in results)
        if found:
            stats.ok(f"LightRAG {label}")
        else:
            paths = [res.get("section_path", "?")[:20] for res in results[:2]]
            stats.fail(f"LightRAG {label}", f"路径不匹配: {paths}")
    except Exception as e:
        stats.fail(f"LightRAG {label}", str(e))

# ── 4. Verify 搜索（按质控编码）─────────────────────────────
print("\n" + "=" * 70)
print("4. Verify 搜索（按质控编码）")
print("=" * 70)

VERIFY_CASES = [
    ("质控规则内容示例", "A004.001", "A004.001"),
    ("质控规则内容示例", "B001.001", "B001.001"),
    ("质控规则内容示例", "J001.001", "J001.001"),
]

for query, qc_code, label in VERIFY_CASES:
    try:
        r = requests.post(f"{BASE}/rag_verify_search", json={
            "query_text": query,
            "note_qc_code": qc_code,
            "similarity_threshold": 0.3
        }, timeout=TIMEOUT)
        results = r.json() if isinstance(r.json(), list) else []
        
        if results and len(results) > 0:
            sim = results[0].get("similarity", 0)
            stats.ok(f"Verify {label} (sim={sim:.2f})")
        else:
            stats.fail(f"Verify {label}", "无结果")
    except Exception as e:
        stats.fail(f"Verify {label}", str(e))

# ── 5. 边界情况 ───────────────────────────────────────────
print("\n" + "=" * 70)
print("5. 边界情况")
print("=" * 70)

# 5.1 空查询
try:
    r = requests.post(f"{BASE}/rag_pageindex_search", json={
        "query_text": "",
        "doc_ids": [210]
    }, timeout=TIMEOUT)
    if r.status_code == 200:
        stats.ok("空查询不崩溃")
    else:
        stats.fail("空查询不崩溃", f"status={r.status_code}")
except Exception as e:
    stats.fail("空查询不崩溃", str(e))

# 5.2 不存在的 doc_ids
try:
    r = requests.post(f"{BASE}/rag_pageindex_search", json={
        "query_text": "肺炎诊断",
        "doc_ids": [99999]
    }, timeout=TIMEOUT)
    results = r.json() if isinstance(r.json(), list) else []
    if r.status_code == 200 and len(results) == 0:
        stats.ok("不存在的doc_ids返回空")
    else:
        stats.fail("不存在的doc_ids返回空", f"results={len(results)}")
except Exception as e:
    stats.fail("不存在的doc_ids返回空", str(e))

# 5.3 无 doc_ids（应返回空或全部）
try:
    r = requests.post(f"{BASE}/rag_pageindex_search", json={
        "query_text": "肺炎诊断"
    }, timeout=TIMEOUT)
    if r.status_code == 200:
        stats.ok("无doc_ids不崩溃")
    else:
        stats.fail("无doc_ids不崩溃", f"status={r.status_code}")
except Exception as e:
    stats.fail("无doc_ids不崩溃", str(e))

# 5.4 超长查询
try:
    long_query = "肺炎诊断标准" * 100
    r = requests.post(f"{BASE}/rag_pageindex_search", json={
        "query_text": long_query,
        "doc_ids": [210]
    }, timeout=TIMEOUT)
    if r.status_code == 200:
        stats.ok("超长查询不崩溃")
    else:
        stats.fail("超长查询不崩溃", f"status={r.status_code}")
except Exception as e:
    stats.fail("超长查询不崩溃", str(e))

# 5.5 高阈值（应返回空）
try:
    r = requests.post(f"{BASE}/rag_pageindex_search", json={
        "query_text": "肺炎诊断",
        "doc_ids": [210],
        "similarity_threshold": 0.99
    }, timeout=TIMEOUT)
    results = r.json() if isinstance(r.json(), list) else []
    if r.status_code == 200 and len(results) == 0:
        stats.ok("高阈值返回空")
    else:
        stats.fail("高阈值返回空", f"results={len(results)}")
except Exception as e:
    stats.fail("高阈值返回空", str(e))

# ── 6. 数据完整性 ─────────────────────────────────────────
print("\n" + "=" * 70)
print("6. 数据完整性")
print("=" * 70)

try:
    import psycopg2
    conn = psycopg2.connect(host='localhost', port=5433, dbname='rag', user='postgres', password='postgres')
    cur = conn.cursor()
    
    # 6.1 段落总数
    cur.execute("SELECT COUNT(*) FROM data.rag_passage")
    total = cur.fetchone()[0]
    if total >= 1000:
        stats.ok(f"段落总数充足 ({total})")
    else:
        stats.fail(f"段落总数充足", f"只有 {total}")
    
    # 6.2 有向量的段落
    cur.execute("SELECT COUNT(*) FROM data.rag_passage WHERE embedding IS NOT NULL")
    has_emb = cur.fetchone()[0]
    if has_emb == total:
        stats.ok(f"所有段落都有向量 ({has_emb}/{total})")
    else:
        stats.fail(f"所有段落都有向量", f"{has_emb}/{total}")
    
    # 6.3 启用的段落
    cur.execute("SELECT COUNT(*) FROM data.rag_passage WHERE enabled = true")
    enabled = cur.fetchone()[0]
    if enabled == total:
        stats.ok(f"所有段落都启用 ({enabled}/{total})")
    else:
        stats.fail(f"所有段落都启用", f"{enabled}/{total}")
    
    # 6.4 文档节点
    cur.execute("SELECT COUNT(*) FROM data.rag_source_doc")
    docs = cur.fetchone()[0]
    if docs >= 10:
        stats.ok(f"文档节点充足 ({docs})")
    else:
        stats.fail(f"文档节点充足", f"只有 {docs}")
    
    # 6.5 Verify 记录
    cur.execute("SELECT COUNT(*) FROM data.rag_verify")
    verify = cur.fetchone()[0]
    if verify >= 5:
        stats.ok(f"Verify 记录充足 ({verify})")
    else:
        stats.fail(f"Verify 记录充足", f"只有 {verify}")
    
    cur.close()
    conn.close()
except Exception as e:
    stats.fail("数据完整性检查", str(e))

# ── 汇总 ─────────────────────────────────────────────────
print("\n" + "=" * 70)
print("汇总")
print("=" * 70)

total = stats.passed + stats.failed
rate = stats.passed / total * 100 if total > 0 else 0
print(f"总计: {stats.passed}/{total} 通过 ({rate:.1f}%)")

if stats.errors:
    print(f"\n失败项 ({len(stats.errors)}):")
    for name, msg in stats.errors:
        print(f"  - {name}: {msg}")
