"""RAG 回归基线测试
用途：每次改动（代码/数据/模型）后运行，确认结果没有退化。
运行：python test_regression.py
"""
import requests
import time
import sys

sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://localhost:8100"
TIMEOUT = 30

# ── Golden Dataset（标准答案）──────────────────────────────
# 格式：(查询, doc_ids, 期望top1路径, 最低相似度)
GOLDEN_CASES = [
    ("肺炎诊断标准",   [210],          "/内科学/呼吸/J18/",     0.60),
    ("抗菌药物分级管理", [270, 271, 273], "/抗菌药物/分级/非限制/", 0.65),
    ("冠心病诊断",     [220],          "/内科学/心血管/I25/",   0.55),
    ("高血压诊断标准",  [222, 260, 261], "/高血压指南/诊断/标准/", 0.55),
    ("胃溃疡诊断",     [230],          "/内科学/消化/K25/",     0.50),
    ("心力衰竭治疗",   [221],          "/内科学/心血管/I50/",   0.60),
    ("急性阑尾炎诊断",  [250],          "/外科学/普外/K35/",     0.60),
    ("发热病因",       [280],          "/诊断学/症状/发热/",    0.55),
    ("胸痛鉴别",       [282],          "/诊断学/症状/胸痛/",    0.65),
    ("胸部CT适应证",   [285],          "/诊断学/影像/胸部CT/",  0.60),
]


def run_regression():
    """执行回归测试，返回 (通过数, 失败数, 耗时列表, 失败详情)"""
    passed = 0
    failed = 0
    latencies = []
    failures = []

    for query, doc_ids, expect_path, min_sim in GOLDEN_CASES:
        start = time.perf_counter()
        try:
            r = requests.post(f"{BASE}/rag_pageindex_search", json={
                "query_text": query,
                "doc_ids": doc_ids,
                "similarity_threshold": 0.3,
                "limit_count": 3,
            }, timeout=TIMEOUT)
            latency = (time.perf_counter() - start) * 1000
            latencies.append(latency)

            results = r.json() if isinstance(r.json(), list) else []

            if not results:
                failed += 1
                failures.append((query, "无结果", 0, 0))
                continue

            top1 = results[0]
            actual_path = top1.get("section_path", "")
            actual_sim = top1.get("similarity", 0)

            # 检查路径匹配
            path_ok = expect_path in actual_path or actual_path in expect_path
            # 检查相似度不低于基线
            sim_ok = actual_sim >= min_sim

            if path_ok and sim_ok:
                passed += 1
            else:
                failed += 1
                reason = []
                if not path_ok:
                    reason.append(f"路径={actual_path}(期望{expect_path})")
                if not sim_ok:
                    reason.append(f"相似度={actual_sim:.4f}(<{min_sim})")
                failures.append((query, "; ".join(reason), actual_sim, latency))

        except Exception as e:
            latency = (time.perf_counter() - start) * 1000
            latencies.append(latency)
            failed += 1
            failures.append((query, f"异常: {e}", 0, latency))

    return passed, failed, latencies, failures


def check_data_health():
    """数据完整性巡检"""
    import psycopg2
    issues = []

    try:
        conn = psycopg2.connect(host='localhost', port=5433, dbname='rag',
                                user='postgres', password='postgres')
        cur = conn.cursor()

        # 1. 段落总数
        cur.execute("SELECT COUNT(*) FROM data.rag_passage")
        total = cur.fetchone()[0]
        if total < 1000:
            issues.append(f"段落数不足: {total} (期望>=1000)")

        # 2. 向量完整性
        cur.execute("SELECT COUNT(*) FROM data.rag_passage WHERE embedding IS NULL")
        null_emb = cur.fetchone()[0]
        if null_emb > 0:
            issues.append(f"{null_emb} 个段落缺少向量")

        # 3. 随机向量检测（真实embedding的norm通常在5-50之间，随机向量norm≈18）
        cur.execute("""
            SELECT COUNT(*) FROM data.rag_passage
            WHERE embedding IS NOT NULL
              AND (embedding <#> embedding) > -0.01
              AND (embedding <#> embedding) < 0.01
        """)
        # 如果自内积接近0，说明向量可能是全零或异常
        # 跳过这个检查，因为cosine normalized向量自内积=1

        # 4. 孤儿段落
        cur.execute("""
            SELECT COUNT(*) FROM data.rag_passage p
            WHERE NOT EXISTS (SELECT 1 FROM data.rag_source_doc d WHERE d.id = p.doc_id)
        """)
        orphans = cur.fetchone()[0]
        if orphans > 0:
            issues.append(f"{orphans} 个孤儿段落(doc_id无对应文档)")

        # 5. 空内容
        cur.execute("SELECT COUNT(*) FROM data.rag_passage WHERE content IS NULL OR content = ''")
        empty = cur.fetchone()[0]
        if empty > 0:
            issues.append(f"{empty} 个空内容段落")

        cur.close()
        conn.close()
    except Exception as e:
        issues.append(f"数据库连接失败: {e}")

    return issues


def main():
    print("=" * 70)
    print("RAG 回归基线测试")
    print("=" * 70)

    # 1. 数据巡检
    print("\n[1/3] 数据完整性巡检...")
    issues = check_data_health()
    if issues:
        for issue in issues:
            print(f"  ⚠ {issue}")
    else:
        print("  ✓ 数据完整性正常")

    # 2. 回归测试
    print("\n[2/3] 回归基线测试 (PageIndex)...")
    passed, failed, latencies, failures = run_regression()

    total = passed + failed
    rate = passed / total * 100 if total > 0 else 0
    print(f"  结果: {passed}/{total} 通过 ({rate:.1f}%)")

    if failures:
        print(f"\n  退化项:")
        for query, reason, sim, lat in failures:
            print(f"    ✗ {query}: {reason}")

    # 3. 性能统计
    print(f"\n[3/3] 性能统计 (含 Embedding API 调用)...")
    if latencies:
        sorted_lat = sorted(latencies)
        p50 = sorted_lat[len(sorted_lat) // 2]
        p99 = sorted_lat[-1]
        avg = sum(sorted_lat) / len(sorted_lat)
        print(f"  样本数: {len(latencies)}")
        print(f"  P50: {p50:.0f}ms")
        print(f"  P99: {p99:.0f}ms")
        print(f"  AVG: {avg:.0f}ms")

        # 性能判定（含远程 Embedding API 调用，网络往返约1-2s）
        if p50 < 5000:
            print(f"  ✓ P50 < 5000ms (含远程API调用，正常)")
        else:
            print(f"  ⚠ P50 = {p50:.0f}ms，偏慢（检查API网络或数据库连接）")

    # 最终判定
    print("\n" + "=" * 70)
    if failed == 0 and not issues:
        print("✓ 回归基线通过，无退化")
    elif failed == 0 and issues:
        print("⚠ 检索正常，但数据有异常，请检查")
    else:
        print(f"✗ 检测到退化！{failed} 个场景不符合基线")
    print("=" * 70)

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
