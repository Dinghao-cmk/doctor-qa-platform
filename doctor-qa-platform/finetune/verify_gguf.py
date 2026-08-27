"""verify_gguf.py - 对比 GGUF 权重与 merged-bf16 权重（区分合并/转换问题）"""
import torch
from gguf import GGUFReader
from safetensors import safe_open
import glob

GGUF = r"D:\models\qwen2.5-7b-med-f16.gguf"
MERGED = r"C:\在水医方\doctor-qa-platform\finetune\output\merged-bf16"

reader = GGUFReader(GGUF)

# 目标 tensor：blk.0.attn_q（有 LoRA）、blk.0.attn_norm（无 LoRA）、token_embd
targets = {
    "token_embd.weight": "model.embed_tokens.weight",
    "blk.0.attn_norm.weight": "model.layers.0.input_layernorm.weight",
    "blk.0.attn_q.weight": "model.layers.0.self_attn.q_proj.weight",
    "blk.0.ffn_gate.weight": "model.layers.0.mlp.gate_proj.weight",
    "blk.27.ffn_down.weight": "model.layers.27.mlp.down_proj.weight",
}

want_hf = set(targets.values())
merged = {}
for f in sorted(glob.glob(MERGED + r"\model-*.safetensors")):
    with safe_open(f, framework="pt") as sf:
        for name in want_hf:
            if name in sf.keys():
                merged[name] = sf.get_tensor(name)

tensors_by_name = {t.name: t for t in reader.tensors}
for gguf_name, hf_name in targets.items():
    t = tensors_by_name.get(gguf_name)
    if t is None:
        print(f"{gguf_name}: GGUF 中不存在（共有 {len(reader.tensors)} 个 tensor）")
        continue
    gguf_t = torch.tensor(t.data.reshape(t.shape), dtype=torch.float16)
    hf_t = merged[hf_name].float()
    if gguf_t.shape != hf_t.shape:
        print(f"{gguf_name}: shape 不匹配 GGUF={gguf_t.shape} HF={hf_t.shape}")
        continue
    diff = (gguf_t.float() - hf_t).abs().mean().item()
    sim = torch.cosine_similarity(gguf_t.flatten().unsqueeze(0), hf_t.flatten().unsqueeze(0)).item()
    print(f"{gguf_name}: shape={gguf_t.shape} 平均绝对差={diff:.6f} 余弦相似={sim:.6f}")
