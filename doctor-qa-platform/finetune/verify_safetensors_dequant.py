"""verify_safetensors_dequant.py - 直接读 safetensors 4bit 权重做 CPU 反量化，对比 merged（极低内存）"""
import glob
import io
import json
import os

import torch

from safetensors import safe_open
from safetensors.torch import load_file
import bitsandbytes as bnb

BASE = r"D:\models\Qwen2.5-7B-Instruct"
LORA_DIR = r"C:\在水医方\doctor-qa-platform\finetune\output\qwen2.5-7b-med"
MERGED = r"C:\在水医方\doctor-qa-platform\finetune\output\merged-bf16"
OUT_LOG = r"D:\verify-dequant.log"

log = open(OUT_LOG, "w", encoding="utf-8", buffering=1)


def p(msg):
    print(msg, flush=True)
    log.write(msg + "\n")


# 目标层：q_proj（有 LoRA）、lm_head（嫌疑）、attn_norm（无 LoRA）
targets = [
    "model.layers.0.self_attn.q_proj",
    "model.layers.0.self_attn.v_proj",
    "model.layers.0.input_layernorm",
    "model.layers.13.mlp.down_proj",
    "model.layers.27.self_attn.q_proj",
    "lm_head",
]

# merged 索引
merged_index = {}
for f in sorted(os.listdir(MERGED)):
    fp = os.path.join(MERGED, f)
    if not f.endswith(".safetensors"):
        continue
    with safe_open(fp, framework="pt") as sf:
        for n in sf.keys():
            merged_index[n] = fp

# LoRA
with open(os.path.join(LORA_DIR, "adapter_config.json"), encoding="utf-8") as f:
    lora_cfg = json.load(f)
scale = lora_cfg["lora_alpha"] / lora_cfg["r"]
lora_state = load_file(os.path.join(LORA_DIR, "adapter_model.safetensors"))
lora_names = {k.split(".lora_A")[0] for k in lora_state if ".lora_A." in k}

for name in targets:
    wname = name + ".weight"
    qsname = wname + ".quant_state"
    found = False
    for f in sorted(glob.glob(BASE + r"\model-*.safetensors")):
        with safe_open(f, framework="pt") as sf:
            if wname not in sf.keys():
                continue
            w_raw = sf.get_tensor(wname)
            if qsname in sf.keys():
                qs_bytes = sf.get_tensor(qsname)
                qs = torch.load(io.BytesIO(qs_bytes.numpy().tobytes()), weights_only=False)
                w = bnb.functional.dequantize_4bit(w_raw, qs)
                p(f"{wname}: 4bit 反量化 OK, shape={w.shape}, dtype={w.dtype}")
            else:
                w = w_raw
                p(f"{wname}: 非量化权重, dtype={w_raw.dtype}, shape={w_raw.shape}")
            found = True
            break
    if not found:
        p(f"{wname}: 原始模型中不存在")
        continue
    w = w.float()

    # 加 LoRA（如适用）
    lora_key = "base_model.model." + name
    if lora_key in lora_names:
        A = lora_state[f"{lora_key}.lora_A.weight"]
        B = lora_state[f"{lora_key}.lora_B.weight"]
        w = w + ((B @ A) * scale).float()
        p(f"  已加 LoRA delta (scale={scale})")

    # 对比 merged
    if wname in merged_index:
        with safe_open(merged_index[wname], framework="pt") as sf:
            m = sf.get_tensor(wname).float()
        if w.shape == m.shape:
            diff = (w - m).abs().mean().item()
            sim = torch.cosine_similarity(w.flatten().unsqueeze(0), m.flatten().unsqueeze(0)).item()
            p(f"  merged 对比: 均差={diff:.8f} 余弦={sim:.6f} {'✅' if diff < 1e-3 else '❌ 差异!'}")
        else:
            p(f"  merged shape 不匹配: {w.shape} vs {m.shape}")
    else:
        p(f"  merged 中不存在")

p("=== 验证完成 ===")
log.close()
