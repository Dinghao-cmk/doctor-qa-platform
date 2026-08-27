# -*- coding: utf-8 -*-
"""对比 r4(v3) 与 r4-v5 在评测集上的表现：分组统计 + 关键样本"""
import json

r = json.load(open(r"c:\在水医方\doctor-qa-platform\finetune\eval_compare_result.json", encoding="utf-8"))
m = r["models"]["med_v5"]
j = m["judge"]
old, new = j[:74], j[74:]


def stat(items, name):
    ok = sum(1 for s in items if s["correct"])
    pos = [s for s in items if s["expected"] == "正确"]
    neg = [s for s in items if s["expected"] == "不正确"]
    print(f"{name}: {ok}/{len(items)} ({ok/len(items)*100:.1f}%) | 正 {sum(1 for s in pos if s['correct'])}/{len(pos)} | 负 {sum(1 for s in neg if s['correct'])}/{len(neg)}")


stat(old, "旧74条")
stat(new, "新30条")
print()
print("--- 新样本判错清单（v5 版）---")
for s in new:
    if not s["correct"]:
        print(f"期望={s['expected']} 实际={s['got']} | {s['claim'][:55]}")
print()
print("--- 泛化题（v5 版）---")
for g in m["generalization"]:
    mark = "OK" if g["correct"] else "XX"
    print(f"[{mark}] 期望={g['expected']} 实际={g['got']} | {g['claim'][:45]}")
