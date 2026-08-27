"""fix_qa_layers.py - 去掉 peft 合并权重名中的 .base_layer 前缀（med-qa 版，输出目录 merged-qa）"""
import gc
import json
import os

from safetensors.torch import load_file, save_file

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output", "merged-qa")
files = sorted(f for f in os.listdir(OUT) if f.endswith(".safetensors"))

weight_map = {}
for f in files:
    path = os.path.join(OUT, f)
    sd = load_file(path)  # CPU 加载（每片 ~1.7GB，处理完释放）
    new_sd = {}
    for name, t in sd.items():
        new_name = name.replace(".base_layer", "")
        new_sd[new_name] = t
        weight_map[new_name] = f
    del sd
    gc.collect()
    save_file(new_sd, path)
    del new_sd
    gc.collect()
    print("已修正", f)

total = sum(os.path.getsize(os.path.join(OUT, f)) for f in files)
with open(os.path.join(OUT, "model.safetensors.index.json"), "w", encoding="utf-8") as fh:
    json.dump({"metadata": {"total_size": total}, "weight_map": weight_map}, fh, ensure_ascii=False, indent=2)
print("完成, 权重条目:", len(weight_map))
