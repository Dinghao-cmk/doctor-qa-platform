"""
merge_4bit.py - 将 LoRA 合并进 4bit 基础模型（save_method=merged_4bit 低显存）
用法: python finetune/merge_4bit.py
输出: finetune/output/merged-4bit/（HF 格式 4bit safetensors）
"""
import os
import time

from unsloth import FastLanguageModel  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_MODEL = r"D:\models\Qwen2.5-7B-Instruct"
LORA_DIR = os.path.join(HERE, "output", "qwen2.5-7b-med")
MERGE_DIR = os.path.join(HERE, "output", "merged-4bit")

t0 = time.time()
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=BASE_MODEL,
    max_seq_length=1024,
    dtype=None,
    load_in_4bit=True,
)
model = FastLanguageModel.from_pretrained(model=model, model_name=LORA_DIR)
print("LoRA 加载完成", round(time.time() - t0), "s")

# save_method=merged_4bit: 保持 4bit 合并，显存占用低（~5GB）
model.save_pretrained_merged(MERGE_DIR, tokenizer, save_method="merged_4bit")
print("4bit 合并完成，耗时", round(time.time() - t0), "s ->", MERGE_DIR)
