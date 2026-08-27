# -*- coding: utf-8 -*-
"""
eval_vl.py - 评测微调后的 Qwen2.5-VL：10 张测试图（训练时没见过）
对比：微调前 base vs 微调后（exp-vl-r4/final）
指标：异常项目级 precision/recall/F1 + 整张图完全正确率
"""
import json
import os
import re
import torch
from unsloth import FastVisionModel
from transformers import AutoProcessor

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_MODEL = r"D:\models\Qwen2.5-VL-3B-Instruct"
ADAPTER = os.path.join(HERE, "output", "exp-vl-r4", "final")
TEST_FILE = os.path.join(HERE, "vl_data", "vl_test.jsonl")

QUESTION = "请阅读这张检验报告单，哪些项目超出参考范围？请逐项列出异常项目、数值、单位和参考范围。"


def load_model(adapter_dir=None):
    model, tokenizer = FastVisionModel.from_pretrained(
        BASE_MODEL,
        load_in_4bit=True,
        dtype=None,
    )
    if adapter_dir:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter_dir)
    FastVisionModel.for_inference(model)
    return model, tokenizer


def ask(model, processor, img_path):
    msg = [
        {
            "role": "user",
            "content": [
                {"type": "image", "image": img_path},
                {"type": "text", "text": QUESTION},
            ],
        },
    ]
    text = processor.apply_chat_template(msg, tokenize=False, add_generation_prompt=True)
    inputs = processor(text=[text], images=[img_path], return_tensors="pt").to("cuda")
    with torch.inference_mode():
        out = model.generate(**inputs, max_new_tokens=300, temperature=1e-5)
    return processor.decode(out[0][inputs.input_ids.shape[1]:], skip_special_tokens=True).strip()


def parse_abnormal(answer):
    """从回答中提取 (项目名, 数值) 异常对：只解析'异常项目共N项：'到'其余'之间的异常列表段"""
    found = []
    if "异常项目共" not in answer:
        return found
    seg = answer.split("异常项目共")[1]
    if "其余" in seg:
        seg = seg.split("其余")[0]
    seg = seg.split("。")[0]
    pat = re.compile(r"([\u4e00-\u9fff（）()A-Za-z]+?)[\s:：]*(\d+\.?\d*)")
    for m in pat.finditer(seg):
        name = m.group(1).strip("（()）")
        if len(name) < 2 or "项" in name or "异常" in name or "参考" in name:
            continue
        found.append((name, float(m.group(2))))
    return found


def get_gold(record):
    """从标注中提取异常 (项目名, 数值) 对"""
    gold = []
    # 直接解析 assistant 回答第一段："异常项目共N项：X 12.2 10^9/L（参考3.5-9.5，偏低）；Y ..."
    ans = record["conversations"][1]["content"]
    seg = ans.split("异常项目共")[1].split("。")[0]
    seg = re.sub(r"^1项：|^\d+项：", "", seg)
    for part in seg.split("；"):
        m = re.match(r"([\u4e00-\u9fff（）()A-Za-z]+?)[\s:：]*(\d+\.?\d*)", part.strip())
        if m:
            gold.append((m.group(1).strip("（()）"), float(m.group(2))))
    return gold


def main():
    records = [json.loads(l) for l in open(TEST_FILE, encoding="utf-8")]
    processor = AutoProcessor.from_pretrained(BASE_MODEL)

    results = {}
    for tag, adapter in [("ft", ADAPTER)]:
        print(f"\n=== 加载模型: {tag} ===")
        model, _ = load_model(adapter)
        stats = {"correct": 0, "total": 0, "p_sum": 0, "r_sum": 0}
        details = []
        for r in records:
            gold = get_gold(r)
            answer = ask(model, processor, r["image"])
            found = parse_abnormal(answer)
            # 匹配：gold 中的 (name, val) 是否都出现在回答里
            hit = 0
            for gname, gval in gold:
                for fname, fval in found:
                    if (gname in fname or fname in gname) and abs(gval - fval) < 0.5:
                        hit += 1
                        break
            tp = hit
            fp = max(0, len(found) - len(gold))  # 粗糙估计：多报即误报
            fn = len(gold) - hit
            p = tp / (tp + fp) if tp + fp else 0
            recall = tp / (tp + fn) if tp + fn else 0
            stats["p_sum"] += p
            stats["r_sum"] += recall
            ok = (hit == len(gold)) and (len(found) <= len(gold))
            if ok:
                stats["correct"] += 1
            stats["total"] += 1
            details.append((ok, r["image"].split("\\")[-1], gold, found, answer[:150]))
        results[tag] = stats, details
        print(f"[{tag}] 完全正确 {stats['correct']}/{stats['total']} | "
              f"avg precision {stats['p_sum']/stats['total']:.2f} | avg recall {stats['r_sum']/stats['total']:.2f}")

    # 打印细节对比
    _, details = results["ft"]
    print("\n=== 微调后逐题明细 ===")
    for ok, name, gold, found, ans in details:
        mark = "✓" if ok else "✗"
        print(f"\n{mark} {name} 期望={gold}")
        print(f"  识别={found}")
        print(f"  回答={ans}")


if __name__ == "__main__":
    main()
