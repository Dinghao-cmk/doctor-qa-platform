"""verify_lora_merge.py - 验证 bnb 反量化 + LoRA 合并的正确性（对照原始模型逐层）"""
import json
import os

import torch

from safetensors import safe_open
from safetensors.torch import load_file

BASE = r"D:\models\Qwen2.5-7B-Instruct"
LORA_DIR = r"C:\在水医方\doctor-qa-platform\finetune\output\qwen2.5-7b-med"
MERGED = r"C:\在水医方\doctor-qa-platform\finetune\output\merged-bf16"

from transformers import AutoModelForCausalLM, BitsAndBytesConfig
import bitsandbytes as bnb

print("加载原始 4bit 模型...", flush=True)
model = AutoModelForCausalLM.from_pretrained(
    BASE,
    quantization_config=BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_quant_type="nf4",
    ),
    torch_dtype=torch.bfloat16,
    device_map={"": 0},
)
print("加载完成", flush=True)

# LoRA
with open(os.path.join(LORA_DIR, "adapter_config.json"), encoding="utf-8") as f:
    lora_cfg = json.load(f)
scale = lora_cfg["lora_alpha"] / lora_cfg["r"]
lora_state = load_file(os.path.join(LORA_DIR, "adapter_model.safetensors"))

# 取 layer 0 的 q_proj 验证
name = "model.layers.0.self_attn.q_proj"
p = dict(model.named_parameters())[name + ".weight"]
w = bnb.functional.dequantize_4bit(p.data, p.quant_state).float()
print("dequant q_proj:", w.shape, flush=True)

lora_key = "base_model.model." + name
A = lora_state[f"{lora_key}.lora_A.weight"]  # [r, in]
B = lora_state[f"{lora_key}.lora_B.weight"]  # [out, r]
delta = (B @ A) * scale
expected = w + delta.to(w.dtype)

# merged 里的权重
merged_w = None
for f in sorted(os.listdir(MERGED)):
    fp = os.path.join(MERGED, f)
    if not f.endswith(".safetensors"):
        continue
    with safe_open(fp, framework="pt") as sf:
        if name + ".weight" in sf.keys():
            merged_w = sf.get_tensor(name + ".weight")
            break
print("merged q_proj:", merged_w.shape, flush=True)

diff = (expected.float() - merged_w.float()).abs().mean().item()
same = torch.allclose(expected.float(), merged_w.float(), atol=1e-2)
print(f"平均绝对差: {diff:.8f} | allclose(1e-2): {same}", flush=True)

# 对比没有 LoRA 的层（验证反量化本身）
name2 = "model.layers.0.input_layernorm"
p2 = dict(model.named_parameters())[name2 + ".weight"]
print(f"{name2} 类型: {type(p2).__name__}", flush=True)
for f in sorted(os.listdir(MERGED)):
    fp = os.path.join(MERGED, f)
    if not f.endswith(".safetensors"):
        continue
    with safe_open(fp, framework="pt") as sf:
        if name2 + ".weight" in sf.keys():
            m2 = sf.get_tensor(name2 + ".weight")
            break
print(f"{name2}: 原始={p2.data.dtype} merged={m2.dtype} 一致={torch.allclose(p2.data.float(), m2.float())}", flush=True)
