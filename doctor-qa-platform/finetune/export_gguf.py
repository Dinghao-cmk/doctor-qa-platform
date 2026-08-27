"""
export_gguf.py - 将微调后的 LoRA 合并导出为 GGUF（q4_k_m），供 ollama 部署
用法: python finetune/export_gguf.py
输出: finetune/output/gguf/qwen2.5-7b-med.gguf
"""
import os
import time

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

from unsloth import FastLanguageModel  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_MODEL = r"D:\models\Qwen2.5-7B-Instruct"
LORA_DIR = os.path.join(HERE, "output", "qwen2.5-7b-med")
GGUF_DIR = os.path.join(HERE, "output", "gguf", "qwen2.5-7b-med")

t0 = time.time()

# 1. 加载基础模型（4bit 省显存）并附加 LoRA
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=BASE_MODEL,
    max_seq_length=1024,
    dtype=None,
    load_in_4bit=True,
)
model = FastLanguageModel.from_pretrained(
    model=model,
    model_name=LORA_DIR,
)
print("LoRA 加载完成", round(time.time() - t0), "s")

# 2. 导出 GGUF（q4_k_m，与 ollama 常用量化一致）
os.makedirs(GGUF_DIR, exist_ok=True)
model.save_pretrained_gguf(
    GGUF_DIR,
    tokenizer,
    quantization_method="q4_k_m",
)
print("GGUF 导出完成，耗时", round(time.time() - t0), "s")
