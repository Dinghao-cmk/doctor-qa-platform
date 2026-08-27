"""
verify_merge.py - 校验 merged-bf16 权重与基座的一致性（逐张量对比，低内存）
- 非 LoRA 层（layernorm 等）：应与基座完全一致
- LoRA 层（q/k/v/o/gate/up/down）：应接近基座（差异 = LoRA delta，量级小）
- embed_tokens / lm_head：基座不含 LoRA，应完全一致（若不一致说明合并错乱）
"""
import json
import os

from safetensors import safe_open

BASE = r"D:\models\Qwen2.5-7B-Instruct"
MERGED = r"c:\在水医方\doctor-qa-platform\finetune\output\merged-bf16"

import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--merged", type=str, default=MERGED, help="合并输出目录")
args = parser.parse_args()
MERGED = args.merged

# 分片文件名列表
base_files = [f for f in os.listdir(BASE) if f.startswith("model-") and f.endswith(".safetensors")]
merged_files = [f for f in os.listdir(MERGED) if f.startswith("model-") and f.endswith(".safetensors")]
print("基座分片:", sorted(base_files))
print("合并分片:", sorted(merged_files))

# 构建 张量名 -> 文件 映射
def build_map(files, root):
    m = {}
    for f in files:
        with safe_open(os.path.join(root, f), framework="pt", device="cpu") as sf:
            for k in sf.keys():
                m[k] = f
    return m

base_map = build_map(base_files, BASE)
merged_map = build_map(merged_files, MERGED)
print(f"基座张量: {len(base_map)} 个, 合并张量: {len(merged_map)} 个")

# 张量名集合对比
missing = set(base_map) - set(merged_map)
extra = set(merged_map) - set(base_map)
if missing:
    print("[错误] 合并缺少张量:", list(missing)[:10])
if extra:
    print("[错误] 合并多出张量:", list(extra)[:10])
if not missing and not extra:
    print("张量名集合一致")

# LoRA 层识别（q/k/v/o/gate/up/down_proj）
lora_prefixes = ("self_attn.", "mlp.")

def compare(name):
    with safe_open(os.path.join(BASE, base_map[name]), framework="pt", device="cpu") as bf, \
         safe_open(os.path.join(MERGED, merged_map[name]), framework="pt", device="cpu") as mf:
        a = bf.get_tensor(name)
        b = mf.get_tensor(name)
        if a.shape != b.shape:
            return f"形状不一致 {tuple(a.shape)} vs {tuple(b.shape)}"
        import torch
        diff = (a - b).abs().max().item()
        return f"max_abs_diff={diff:.6e}"

print("\n=== 抽样对比（非 LoRA 层应完全一致）===")
for n in ["model.embed_tokens.weight", "lm_head.weight", "model.norm.weight",
          "model.layers.0.input_layernorm.weight", "model.layers.5.post_attention_layernorm.weight"]:
    print(f"{n}: {compare(n)}")

print("\n=== 抽样对比（LoRA 层应差异较小）===")
for n in ["model.layers.0.self_attn.q_proj.weight", "model.layers.10.mlp.gate_proj.weight",
          "model.layers.20.self_attn.o_proj.weight", "model.layers.27.mlp.down_proj.weight"]:
    print(f"{n}: {compare(n)}")
