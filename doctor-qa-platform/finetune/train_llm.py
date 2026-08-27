"""
train_llm.py - 医学 RAG 回答能力微调（Qwen2.5-7B QLoRA，Unsloth）
- 数据：finetune/rag_train.jsonl（alpaca 格式 instruction/input/output）
- 硬件：RTX 4060 Laptop 8GB（训练前请停止 ollama 释放显存）
- 输出：finetune/output/qwen2.5-7b-med（LoRA 权重）→ 导出 GGUF → ollama 部署

用法：
  conda activate embed-train
  python finetune/train_llm.py              # 完整训练
  python finetune/train_llm.py --epochs 2   # 覆盖 epoch
  python finetune/train_llm.py --test       # 只加载模型 + 跑 1 条推理（环境验证）
"""
import argparse
import json
import os
import sys
import time

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(HERE, "rag_train_v3.jsonl")
OUT_DIR = os.path.join(HERE, "output", "qwen2.5-7b-med")
MODEL_ID = r"D:\models\Qwen2.5-7B-Instruct"  # 本地权重（modelscope/hf 下载）

# 与线上 system prompt 保持一致（保证微调后可被线上 prompt 触发）
SYSTEM_PROMPT = "你是一位专业的医学知识问答助手，服务于临床医生。回答必须严格基于提供的参考资料，每个要点标注 [参考N]，不编造、不补充资料外的内容，不确定处如实说明。"


def build_prompt(example, tokenizer):
    """组装 chat 格式训练样本（input 含参考资料+问题），返回 text 列（apply_chat_template 预拼接）
    支持 history 字段（[{role, content}]，多轮对话样本）
    """
    instruction = example.get("instruction") or SYSTEM_PROMPT
    user_text = example.get("input", "")
    output = example.get("output", "")
    messages = [
        {"role": "system", "content": instruction},
    ]
    # 多轮历史（如有）：user/assistant 交替插入
    for h in example.get("history", []):
        if h.get("role") in ("user", "assistant") and h.get("content"):
            messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": user_text})
    messages.append({"role": "assistant", "content": output})
    return {"text": tokenizer.apply_chat_template(messages, tokenize=False)}


def load_data():
    if not os.path.exists(DATA_FILE):
        print(f"[错误] 训练数据不存在: {DATA_FILE}")
        sys.exit(1)
    samples = []
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                samples.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"[警告] 跳过非法行: {e}")
    print(f"数据加载: {len(samples)} 条")
    return samples


def check_gpu():
    if not torch.cuda.is_available():
        print("[错误] CUDA 不可用，无法训练")
        sys.exit(1)
    name = torch.cuda.get_device_name(0)
    total = torch.cuda.get_device_properties(0).total_memory / 1024**3
    free = torch.cuda.mem_get_info()[1] / 1024**3  # free(1)=total
    used = total - torch.cuda.mem_get_info()[0] / 1024**3
    print(f"GPU: {name} | 显存: {total:.1f}GB 总量, 已用 {used:.1f}GB, 空闲 {total - used:.1f}GB")
    if used > 2.5:
        print("[警告] 显存占用较高（可能 ollama 未停止），训练可能 OOM。建议先停止 ollama（任务管理器结束 ollama.exe）")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--seq", type=int, default=512)
    parser.add_argument("--batch", type=int, default=1)
    parser.add_argument("--accum", type=int, default=8)
    parser.add_argument("--r", type=int, default=16, help="LoRA 秩（教学实验用）")
    parser.add_argument("--neftune", type=float, default=0, help="NEFTune 噪声强度（默认 0=关闭，推荐 5）")
    parser.add_argument("--out-dir", type=str, default="", help="输出目录（实验用，默认 output/qwen2.5-7b-med）")
    parser.add_argument("--data", type=str, default="", help="训练数据文件（实验用，默认 rag_train_v3.jsonl）")
    parser.add_argument("--test", action="store_true", help="环境验证模式：加载模型并推理一次")
    args = parser.parse_args()
    out_dir = args.out_dir or OUT_DIR
    if args.data:
        global DATA_FILE
        DATA_FILE = os.path.join(HERE, args.data)

    check_gpu()

    from unsloth import FastLanguageModel
    from trl import SFTTrainer, SFTConfig
    from datasets import Dataset

    # 4bit QLoRA 加载（8GB 显存约束）
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=MODEL_ID,
        max_seq_length=args.seq,
        dtype=None,  # 自动
        load_in_4bit=True,
    )
    print("模型加载完成:", MODEL_ID)

    if args.test:
        # 环境验证：微调前推理一次（应是无引用风格的通用回答）
        FastLanguageModel.for_inference(model)
        msg = {
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": "## 参考资料\n【参考1】《内科学第10版》肺炎\n社区获得性肺炎的诊断标准：①社区发病；②发热≥38℃；③咳嗽、咳痰。\n\n## 问题\n社区获得性肺炎的诊断标准是什么？"},
            ]
        }
        text = tokenizer.apply_chat_template(msg["messages"], tokenize=False, add_generation_prompt=True)
        inputs = tokenizer([text], return_tensors="pt").to("cuda")
        out = model.generate(**inputs, max_new_tokens=200, temperature=0.3)
        print("\n[测试推理] 微调前输出:")
        print(tokenizer.decode(out[0][inputs.input_ids.shape[1]:], skip_special_tokens=True))
        return

    # LoRA 配置（r 可调，教学实验：r=4 / 16 / 64 对比）
    print(f"LoRA 配置: r={args.r}, alpha=16, 目标层=7 个线性层")
    print(f"NEFTune: {'开启 alpha=' + str(args.neftune) if args.neftune > 0 else '关闭'}")
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.r,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_alpha=16,
        lora_dropout=0,
        bias="none",
        use_gradient_checkpointing="unsloth",
        random_state=42,
    )

    # 数据
    samples = load_data()
    if len(samples) < 10:
        print(f"[错误] 训练数据过少（{len(samples)} 条），请先运行 generate_rag_data.js 扩充")
        sys.exit(1)
    dataset = Dataset.from_list([build_prompt(s, tokenizer) for s in samples])
    split = dataset.train_test_split(test_size=0.1, seed=42)
    print(f"训练集: {len(split['train'])} 条, 验证集: {len(split['test'])} 条")

    # SFT 训练（8GB 显存：batch=1 + 梯度累积）
    total_steps = len(split["train"]) // (args.batch * args.accum) * args.epochs
    print(f"预计训练步数: ~{total_steps}（epochs={args.epochs}, batch={args.batch}, accum={args.accum}）")

    trainer = SFTTrainer(
        model=model,
        processing_class=tokenizer,
        train_dataset=split["train"],
        eval_dataset=split["test"],
        args=SFTConfig(
            dataset_text_field="text",  # 已预拼接 chat 文本
            max_length=args.seq,
            per_device_train_batch_size=args.batch,
            per_device_eval_batch_size=args.batch,
            gradient_accumulation_steps=args.accum,
            num_train_epochs=args.epochs,
            learning_rate=args.lr,
            lr_scheduler_type="cosine",
            warmup_ratio=0.03,
            logging_steps=5,
            eval_strategy="epoch",
            save_strategy="epoch",
            output_dir=out_dir,
            report_to="none",
            bf16=True,  # Unsloth 4bit 加载为 bf16，需与 fp16 互斥
            fp16=False,
            optim="adamw_8bit",
            neftune_noise_alpha=args.neftune,  # NEFTune：训练时往 embedding 加噪声，提泛化（0=关闭）
            seed=42,
        ),
    )

    t0 = time.time()
    trainer.train()
    print(f"训练完成，耗时 {(time.time() - t0) / 60:.1f} 分钟")

    # 保存 LoRA 权重
    model.save_pretrained(out_dir)
    tokenizer.save_pretrained(out_dir)
    print(f"LoRA 权重已保存: {out_dir}")

    # 可选：验证集抽 1 条推理对比
    FastLanguageModel.for_inference(model)
    sample = split["test"][0]
    # 取 text 列中用户部分重新构造生成提示（截到问题为止）
    import re
    user_part = re.split(r"assistant\n", sample["text"])[0]
    text = user_part + "assistant\n"
    inputs = tokenizer([text], return_tensors="pt").to("cuda")
    out = model.generate(**inputs, max_new_tokens=200, temperature=0.3)
    print("\n[验证推理] 微调后输出:")
    print(tokenizer.decode(out[0][inputs.input_ids.shape[1]:], skip_special_tokens=True))


if __name__ == "__main__":
    main()
