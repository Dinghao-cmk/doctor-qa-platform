"""clean_lora_tensors.py - 剔除合并输出中的 LoRA 原始权重（lora_A/lora_B）"""
import gc
import json
import os

from safetensors import safe_open
from safetensors.torch import load_file, save_file

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output", "merged-bf16")
files = sorted(f for f in os.listdir(OUT) if f.endswith(".safetensors"))

weight_map = {}
for f in files:
    path = os.path.join(OUT, f)
    sd = load_file(path)
    clean = {n: t for n, t in sd.items() if "lora_A" not in n and "lora_B" not in n}
    removed = len(sd) - len(clean)
    del sd
    gc.collect()
    save_file(clean, path)
    del clean
    gc.collect()
    with safe_open(path, framework="pt") as sf:
        for n in sf.keys():
            weight_map[n] = f
    print(f"{f}: 剔除 {removed} 个 LoRA 权重")

total = sum(os.path.getsize(os.path.join(OUT, f)) for f in files)
with open(os.path.join(OUT, "model.safetensors.index.json"), "w", encoding="utf-8") as fh:
    json.dump({"metadata": {"total_size": total}, "weight_map": weight_map}, fh, ensure_ascii=False, indent=2)
print("清理完成, 剩余条目:", len(weight_map))
