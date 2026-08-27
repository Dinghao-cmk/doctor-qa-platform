"""
merge_bf16_direct.py - 直接在 bf16 空间合并 LoRA（CPU 逐层，无量化噪声，内存占用极小）
原始权重为 bf16 safetensors，逐层读入内存合并后逐片保存。
输出: finetune/output/merged-bf16/（8 分片 + index.json + config）
"""
import gc
import json
import os
import time

import torch

from safetensors import safe_open
from safetensors.torch import load_file, save_file

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = r"D:\models\Qwen2.5-7B-Instruct"
LORA_DIR = os.path.join(HERE, "output", "qwen2.5-7b-med")
OUT = os.path.join(HERE, "output", "merged-bf16")

N_SHARDS = 8
t0 = time.time()

# 1. LoRA 权重与配置
with open(os.path.join(LORA_DIR, "adapter_config.json"), encoding="utf-8") as f:
    lora_cfg = json.load(f)
scale = lora_cfg["lora_alpha"] / lora_cfg["r"]
lora_state = load_file(os.path.join(LORA_DIR, "adapter_model.safetensors"))
# 基础权重名 -> LoRA 前缀（去掉 base_model.model. 和 .lora_X.default 后缀）
lora_targets = {}
for k in lora_state:
    if ".lora_A." not in k:
        continue
    base_key = k.replace("base_model.model.", "").replace(".lora_A.default.weight", "")
    lora_targets[base_key] = (f"{k.replace('.lora_A.default.weight', '.lora_A.default.weight')}",
                              f"{k.replace('.lora_A.default.weight', '.lora_B.default.weight')}")
print(f"LoRA 目标层: {len(lora_targets)}, scale={scale}", flush=True)

# 2. 逐 shard 合并
os.makedirs(OUT, exist_ok=True)
shards = sorted(f for f in os.listdir(BASE) if f.startswith("model-") and f.endswith(".safetensors"))
print(f"基础模型分片: {len(shards)} 个", flush=True)

# 收集全部权重名 → 输出分片映射
all_names = []
for sh in shards:
    with safe_open(os.path.join(BASE, sh), framework="pt") as sf:
        all_names.extend(sf.keys())
print(f"总权重: {len(all_names)}", flush=True)

per_batch = max(1, len(all_names) // N_SHARDS)
weight_map = {}
buf = {}
batch_no = 0
idx = 0


def flush():
    global batch_no
    if not buf:
        return
    batch_no += 1
    fp = os.path.join(OUT, f"model-{batch_no:02d}-of-{N_SHARDS:02d}.safetensors")
    save_file(buf, fp)
    for n in buf:
        weight_map[n] = os.path.basename(fp)
    buf.clear()
    gc.collect()
    print(f"  已保存 {os.path.basename(fp)}（累计 {round(time.time() - t0)}s）", flush=True)


for sh in shards:
    sd = load_file(os.path.join(BASE, sh))  # CPU bf16
    for name, t in sd.items():
        if name in lora_targets:
            A = lora_state[lora_targets[name][0]]
            B = lora_state[lora_targets[name][1]]
            delta = (B @ A) * scale
            t = (t.float() + delta.to(t.dtype).float()).to(torch.bfloat16)
        buf[name] = t
        idx += 1
        if idx % per_batch == 0:
            flush()
    del sd
    gc.collect()
flush()
print("合并完成", round(time.time() - t0), "s", flush=True)

# 3. config + index + tokenizer 文件
import shutil as shutil_mod

cfg = json.load(open(os.path.join(BASE, "config.json"), encoding="utf-8"))
cfg["torch_dtype"] = "bfloat16"
for k in ["quantization_config", "quant_method"]:
    cfg.pop(k, None)
json.dump(cfg, open(os.path.join(OUT, "config.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
total = sum(os.path.getsize(os.path.join(OUT, f)) for f in weight_map.values())
json.dump({"metadata": {"total_size": total}, "weight_map": weight_map},
          open(os.path.join(OUT, "model.safetensors.index.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)
for fn in ["tokenizer.json", "tokenizer_config.json", "merges.txt", "vocab.json", "generation_config.json"]:
    src = os.path.join(BASE, fn)
    if os.path.exists(src):
        shutil_mod.copy2(src, os.path.join(OUT, fn))
print("全部完成 ->", OUT, flush=True)
