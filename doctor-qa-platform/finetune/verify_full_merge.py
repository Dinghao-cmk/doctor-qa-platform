"""verify_full_merge.py - 逐层对比 bnb 反量化+LoRA 与 merged-bf16（精确定位差异层）"""
import json
import os

import torch

from safetensors import safe_open

BASE = r"D:\models\Qwen2.5-7B-Instruct"
LORA_DIR = r"C:\在水医方\doctor-qa-platform\finetune\output\qwen2.5-7b-med"
MERGED = r"C:\在水医方\doctor-qa-platform\finetune\output\merged-bf16"
OUT_LOG = r"D:\verify-full.log"

log = open(OUT_LOG, "w", encoding="utf-8", buffering=1)


def p(msg):
    print(msg, flush=True)
    log.write(msg + "\n")


from transformers import AutoModelForCausalLM, BitsAndBytesConfig
import bitsandbytes as bnb
from safetensors.torch import load_file

p("加载原始 4bit 模型（GPU）...")
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
p("加载完成")

with open(os.path.join(LORA_DIR, "adapter_config.json"), encoding="utf-8") as f:
    lora_cfg = json.load(f)
scale = lora_cfg["lora_alpha"] / lora_cfg["r"]
lora_state = load_file(os.path.join(LORA_DIR, "adapter_model.safetensors"))
lora_names = {k.split(".lora_A")[0] for k in lora_state if ".lora_A." in k}

named = dict(model.named_parameters())
weights = [n for n in named if n.endswith(".weight") and "lora_A" not in n and "lora_B" not in n]
p(f"待对比权重 {len(weights)} 个")

# merged 权重索引（文件名映射）
merged_index = {}
for f in sorted(os.listdir(MERGED)):
    fp = os.path.join(MERGED, f)
    if not f.endswith(".safetensors"):
        continue
    with safe_open(fp, framework="pt") as sf:
        for n in sf.keys():
            merged_index[n] = fp

bad = []
checked = 0
for name in weights:
    pobj = named[name]
    save_name = name.replace(".base_layer", "")
    if save_name not in merged_index:
        p(f"[缺失] {save_name}")
        bad.append((name, "missing"))
        continue
    if isinstance(pobj, bnb.nn.Params4bit):
        w = bnb.functional.dequantize_4bit(pobj.data, pobj.quant_state).float()
        lora_key = "base_model.model." + name[:-len(".weight")].replace(".base_layer", "")
        if lora_key in lora_names:
            A = lora_state[f"{lora_key}.lora_A.weight"]
            B = lora_state[f"{lora_key}.lora_B.weight"]
            w = w + ((B @ A) * scale).to(w.dtype)
        w = w.to(torch.bfloat16)
    else:
        w = pobj.data.to(torch.bfloat16)
    with safe_open(merged_index[save_name], framework="pt") as sf:
        m = sf.get_tensor(save_name)
    checked += 1
    if w.shape != m.shape or not torch.allclose(w.float(), m.float(), atol=1e-3):
        diff = (w.float() - m.float()).abs().mean().item() if w.shape == m.shape else -1
        p(f"[差异] {save_name}: shape {w.shape} vs {m.shape}, 均差={diff:.6f}")
        bad.append((name, str(diff)))
        if len(bad) >= 5:
            break

p(f"=== 检查 {checked} 个，差异 {len(bad)} 个 ===")
for b in bad:
    p(f"   {b}")
log.close()
