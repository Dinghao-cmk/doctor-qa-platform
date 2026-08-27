"""verify_embedding.py - 对比 merged-bf16 与原始模型的 token_embd（找乱码根因）"""
import torch

from safetensors import safe_open
from safetensors.torch import load_file
import glob

MERGED = r"C:\在水医方\doctor-qa-platform\finetune\output\merged-bf16"
BASE = r"D:\models\Qwen2.5-7B-Instruct"

# 1. merged 的 token_embd（bf16）
merged_emb = None
for f in sorted(glob.glob(MERGED + r"\model-*.safetensors")):
    with safe_open(f, framework="pt") as sf:
        if "model.embed_tokens.weight" in sf.keys():
            merged_emb = sf.get_tensor("model.embed_tokens.weight")
            break
print("merged token_embd:", merged_emb.shape, merged_emb.dtype, "文件:", f.split("\\")[-1])

# 2. 原始模型的 token_embd（safetensors 直接读，bf16 存储）
base_emb = None
for f in sorted(glob.glob(BASE + r"\model-*.safetensors")):
    with safe_open(f, framework="pt") as sf:
        if "model.embed_tokens.weight" in sf.keys():
            base_emb = sf.get_tensor("model.embed_tokens.weight")
            break
print("base token_embd:", base_emb.shape, base_emb.dtype, "文件:", f.split("\\")[-1])

# 3. 对比
if merged_emb is not None and base_emb is not None:
    diff = (merged_emb.float() - base_emb.float()).abs().mean().item()
    same = torch.equal(merged_emb, base_emb)
    print("逐元素相同:", same, "| 平均绝对差:", diff)
    # 抽样对比某 token 行
    for t in [0, 100, 151644, 151645, 151643]:
        m = merged_emb[t].float()
        b = base_emb[t].float()
        print(f"token {t}: merged[0:4]={m[:4].tolist()} base[0:4]={b[:4].tolist()} 相似={torch.cosine_similarity(m.unsqueeze(0), b.unsqueeze(0)).item():.4f}")
