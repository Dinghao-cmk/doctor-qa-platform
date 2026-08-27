import sys
print("start", flush=True)
try:
    from gguf import GGUFReader
    print("import ok", flush=True)
    r = GGUFReader(r"D:\models\qwen2.5-7b-med-f16.gguf")
    print("reader ok, tensors:", len(r.tensors), flush=True)
    t = r.get_tensor("blk.0.attn_q.weight")
    print("tensor:", t.shape, flush=True)
except Exception as e:
    print("ERROR:", type(e).__name__, str(e)[:300], flush=True)
    sys.exit(1)
