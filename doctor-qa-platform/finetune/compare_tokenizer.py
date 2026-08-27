"""compare_tokenizer.py - 对比我们的 GGUF 与原版 GGUF 的 tokenizer 一致性"""
from gguf import GGUFReader

OURS = r"D:\models\qwen2.5-7b-med-f16.gguf"
ORIG = r"C:\Users\ASUS\.ollama\models\blobs\sha256-2bada8a7450677000f678be90653b85d364de7db25eb5ea54136ada5f3933730"

r1 = GGUFReader(OURS)
r2 = GGUFReader(ORIG)

KEYS = ["tokenizer.ggml.model", "tokenizer.ggml.pre", "tokenizer.ggml.tokens", "tokenizer.ggml.merges",
        "tokenizer.ggml.eos_token_id", "tokenizer.ggml.bos_token_id", "tokenizer.ggml.padding_token_id",
        "general.architecture", "qwen2.context_length", "qwen2.embedding_length", "qwen2.block_count"]

for k in KEYS:
    f1 = r1.fields.get(k)
    f2 = r2.fields.get(k)
    v1 = len(f1.data) if f1 else None
    v2 = len(f2.data) if f2 else None
    same = "?"
    if f1 and f2 and len(f1.data) == len(f2.data) and len(f1.data) < 100:
        try:
            same = (f1.data.tolist() == f2.data.tolist()) if hasattr(f1.data, "tolist") else (list(f1.data) == list(f2.data))
        except Exception:
            same = "?"
    print(f"{k}: ours={v1} orig={v2} 内容一致={same}")

# tokens 内容对比（抽样 2000）
t1 = r1.fields["tokenizer.ggml.tokens"].data
t2 = r2.fields["tokenizer.ggml.tokens"].data
if hasattr(t1, "tolist"):
    a1, a2 = t1.tolist(), t2.tolist()
else:
    a1, a2 = list(t1), list(t2)
print(f"tokens 数: {len(a1)} vs {len(a2)}")
print(f"前 5 个: {a1[:5]} vs {a2[:5]}")
print(f"前 2000 一致: {a1[:2000] == a2[:2000]}")

m1 = r1.fields["tokenizer.ggml.merges"].data
m2 = r2.fields["tokenizer.ggml.merges"].data
if hasattr(m1, "tolist"):
    b1, b2 = m1.tolist(), m2.tolist()
else:
    b1, b2 = list(m1), list(m2)
print(f"merges 数: {len(b1)} vs {len(b2)}, 前 2000 一致: {b1[:2000] == b2[:2000]}")
