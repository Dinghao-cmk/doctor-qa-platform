"""
eval_lora_r.py - LoRA 秩对比实验评测（r=4 / 16 / 64）
- 加载 4bit 基座 + 指定 checkpoint 的 LoRA 权重，批量推理
- 评测集：rag_train_judge.jsonl 全量 74 条判定 + 5 条泛化题
- 用法：python eval_lora_r.py --adapters 目录1:r4 目录2:r16 ...
- 输出：eval_lora_r_result.json（逐条 + 汇总）
"""
import argparse
import json
import os
import re
import sys
import time

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_ID = r"D:\models\Qwen2.5-7B-Instruct"
JUDGE_FILE = os.path.join(HERE, "rag_train_judge.jsonl")

JUDGE_INSTRUCTION = (
    '你是一位病历质控专家，负责复核病历质量缺陷的判定。针对每条"缺陷声称"，结合临床知识判断该声称是否成立：'
    "若成立，说明支持该缺陷的充分理由；若不成立，指出其不准确或过于绝对之处，并给出正确的判断依据。"
    "判定必须严谨、结合临床实际，不得仅凭片面信息下结论。"
)

# 泛化题（两边都没训练过；答案明确）——与 eval_compare.js 保持一致
GENERALIZATION = [
    {"claim": '患者性别记录为女性，但主诉及现病史描述为"前列腺增生"', "verdict": "正确"},
    {"claim": "患者年龄记录45岁，但身份证出生日期计算为21岁，两者矛盾", "verdict": "正确"},
    {"claim": '主诉"发热3天"，但体温单记录均在36.2-36.8℃之间，无发热处理记录', "verdict": "不正确"},
    {"claim": "患者为2型糖尿病多年，本次处方开具二甲双胍，病历无血糖监测记录", "verdict": "正确"},
    {"claim": '病历诊断"急性阑尾炎"，但主诉为"咳嗽咳痰3天"，两者完全无关且无腹部症状描述', "verdict": "正确"},
]


def parse_verdict(text):
    """与 eval_compare.js 的 parseVerdict 保持一致的判定解析"""
    m = re.search(r"判定[:：]\s*(正确|不正确)", text)
    if m:
        return m.group(1)
    n = re.search(r"说法[:：]?\s*(正确|不正确)", text)
    if n:
        return n.group(1)
    if re.search(r"不正确|不成立|不能认定|不能据此|过于绝对|依据不足|并不矛盾|不必然", text):
        return "不正确"
    if re.search(r"正确|成立", text):
        return "正确"
    return None


def load_judge_samples():
    samples = []
    with open(JUDGE_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            s = json.loads(line)
            claim = s["input"].split("判定理由：\n\n")[1] if "判定理由：\n\n" in s["input"] else s["input"]
            verdict = "正确" if s["output"].startswith("判定：正确") else "不正确"
            samples.append({"claim": claim, "verdict": verdict})
    return samples


def build_prompts(samples):
    return [
        f"{JUDGE_INSTRUCTION}\n\n请复核以下病历质控缺陷声称是否成立，并给出判定理由：\n\n{s['claim']}"
        for s in samples
    ]


def run_eval(model, tokenizer, samples, batch_size=4, max_new_tokens=200):
    prompts = build_prompts(samples)
    results = []
    t0 = time.time()
    for i in range(0, len(prompts), batch_size):
        batch = prompts[i : i + batch_size]
        batch_samples = samples[i : i + batch_size]
        msgs = [[{"role": "user", "content": p}] for p in batch]
        texts = [tokenizer.apply_chat_template(m, tokenize=False, add_generation_prompt=True) for m in msgs]
        inputs = tokenizer(texts, return_tensors="pt", padding=True, truncation=True, max_length=1024).to("cuda")
        with torch.no_grad():
            outs = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                temperature=0.3,
                do_sample=True,
                top_p=0.9,
            )
        for j, out in enumerate(outs):
            resp = tokenizer.decode(out[inputs.input_ids.shape[1] :], skip_special_tokens=True).strip()
            got = parse_verdict(resp)
            results.append(
                {
                    "claim": batch_samples[j]["claim"][:60],
                    "expected": batch_samples[j]["verdict"],
                    "got": got,
                    "correct": got == batch_samples[j]["verdict"],
                    "resp": resp[:200],
                }
            )
        done = min(i + batch_size, len(prompts))
        print(f"  进度 {done}/{len(prompts)}，已用 {time.time() - t0:.0f}s")
    return results


def summarize(name, results):
    total = len(results)
    ok = sum(1 for r in results if r["correct"])
    pos = [r for r in results if r["expected"] == "正确"]
    neg = [r for r in results if r["expected"] == "不正确"]
    pos_ok = sum(1 for r in pos if r["correct"])
    neg_ok = sum(1 for r in neg if r["correct"])
    print(f"\n===== {name} =====")
    print(f"总体: {ok}/{total} ({ok / total * 100:.1f}%) | 正样本: {pos_ok}/{len(pos)} ({pos_ok / len(pos) * 100:.1f}%) | 负样本: {neg_ok}/{len(neg)} ({neg_ok / len(neg) * 100:.1f}%)")
    return {
        "total": ok / total,
        "pos": pos_ok / len(pos),
        "neg": neg_ok / len(neg),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapters", required=True, help="checkpoint目录:标签 列表，逗号分隔，如 out-r4/checkpoint-84:r4")
    parser.add_argument("--batch", type=int, default=4)
    args = parser.parse_args()

    adapters = []
    for item in args.adapters.split(","):
        d, label = item.rsplit(":", 1)
        adapters.append((os.path.join(HERE, d), label))

    judge_samples = load_judge_samples()
    print(f"判定样本: {len(judge_samples)} 条（正={sum(1 for s in judge_samples if s['verdict'] == '正确')}, 负={sum(1 for s in judge_samples if s['verdict'] == '不正确')}）")
    print(f"泛化题: {len(GENERALIZATION)} 条")

    from unsloth import FastLanguageModel

    out = {"generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"), "adapters": {}}

    for adapter_dir, label in adapters:
        print(f"\n########## 加载 {label} ({adapter_dir}) ##########")
        t0 = time.time()
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=MODEL_ID,
            max_seq_length=1024,
            dtype=None,
            load_in_4bit=True,
        )
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, adapter_dir)
        FastLanguageModel.for_inference(model)
        print(f"加载完成，用时 {time.time() - t0:.0f}s")

        judge_res = run_eval(model, tokenizer, judge_samples, batch_size=args.batch)
        gen_res = run_eval(model, tokenizer, GENERALIZATION, batch_size=args.batch)
        summary = summarize(label, judge_res)
        gen_ok = sum(1 for r in gen_res if r["correct"])
        summary["gen"] = gen_ok / len(gen_res)
        print(f"泛化: {gen_ok}/{len(gen_res)} ({gen_ok / len(gen_res) * 100:.1f}%)")
        out["adapters"][label] = {
            "adapter_dir": adapter_dir,
            "judge": judge_res,
            "generalization": gen_res,
            "summary": summary,
        }
        # 释放显存，准备下一个
        del model, tokenizer
        torch.cuda.empty_cache()

    print("\n========== r 对比汇总 ==========")
    for label, v in out["adapters"].items():
        s = v["summary"]
        print(f"{label}: 判定 {s['total'] * 100:.1f}% (正 {s['pos'] * 100:.1f}% / 负 {s['neg'] * 100:.1f}%) | 泛化 {s['gen'] * 100:.1f}%")

    with open(os.path.join(HERE, "eval_lora_r_result.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("\n结果已保存: finetune/eval_lora_r_result.json")


if __name__ == "__main__":
    main()
