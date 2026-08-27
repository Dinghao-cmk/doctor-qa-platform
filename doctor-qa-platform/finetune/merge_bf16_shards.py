"""
merge_bf16_shards.py - 低显存 LoRA 合并（8GB VRAM / 16GB RAM 可用）
原理：4bit 模型仅占 4.2GB 显存，逐层反量化+合并 LoRA，每处理 1/8 保存一次分片，
     避免 bf16 全量（14GB）驻留显存/内存。
输出: finetune/output/merged-bf16/（多分片 safetensors + index.json，供 llama.cpp 转 GGUF）
"""
import gc
import io
import json
import os
import time

import torch

from safetensors.torch import save_file

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_MODEL = r"D:\models\Qwen2.5-7B-Instruct"

N_SHARDS = 8  # 输出分片数（控制峰值内存 ~1.75GB/片）
t0 = time.time()


def main():
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--lora-dir", type=str, default=os.path.join(HERE, "output", "qwen2.5-7b-med"), help="LoRA 权重目录")
    parser.add_argument("--out-dir", type=str, default=os.path.join(HERE, "output", "merged-bf16"), help="输出目录")
    args = parser.parse_args()
    LORA_DIR = args.lora_dir
    OUT_DIR = args.out_dir

    from transformers import AutoModelForCausalLM, BitsAndBytesConfig
    import bitsandbytes as bnb
    from peft import PeftModel

    os.makedirs(OUT_DIR, exist_ok=True)

    # 1. 加载 4bit 基础模型（~4.2GB 显存）
    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        quantization_config=BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
        ),
        torch_dtype=torch.bfloat16,
        device_map={"": 0},
    )
    print("4bit 基础模型加载完成", round(time.time() - t0), "s")

    # 2. 附加 LoRA（~150MB）
    model = PeftModel.from_pretrained(model, LORA_DIR)
    print("LoRA 附加完成", round(time.time() - t0), "s")

    # LoRA 超参
    with open(os.path.join(LORA_DIR, "adapter_config.json"), encoding="utf-8") as f:
        lora_cfg = json.load(f)
    scale = lora_cfg["lora_alpha"] / lora_cfg["r"]

    # LoRA 权重（移 GPU 加速合并）
    from safetensors.torch import load_file as sf_load
    lora_state = {k: v.cuda() for k, v in sf_load(os.path.join(LORA_DIR, "adapter_model.safetensors")).items()}
    lora_names = {k.split(".lora_A")[0] for k in lora_state if ".lora_A." in k}
    print(f"LoRA 目标层数: {len(lora_names)}, scale={scale:.2f}")

    base = model.base_model.model
    named_params = dict(base.named_parameters())

    # 3. 逐层反量化 + 合并，分批保存
    os.makedirs(OUT_DIR, exist_ok=True)
    all_names = [n for n in named_params if (n.endswith(".weight") or n.endswith(".bias")) and "lora_A" not in n and "lora_B" not in n]
    per_batch = max(1, len(all_names) // N_SHARDS)
    # 保存文件名到 tensor 名映射（index.json）
    weight_map = {}
    buf = {}
    idx = 0
    batch_no = 0

    def flush():
        nonlocal batch_no
        if not buf:
            return
        batch_no += 1
        shard_file = os.path.join(OUT_DIR, f"model-{batch_no:02d}-of-{N_SHARDS:02d}.safetensors")
        save_file(buf, shard_file)
        for n in buf:
            weight_map[n] = os.path.basename(shard_file)
        buf.clear()
        torch.cuda.empty_cache()
        gc.collect()
        print(f"  已保存 {shard_file}（累计 {round(time.time() - t0)}s）")

    for name in all_names:
        p = named_params[name]
        save_name = name.replace(".base_layer", "")  # 还原原始权重名
        if isinstance(p, bnb.nn.Params4bit):
            w = bnb.functional.dequantize_4bit(p.data, p.quant_state).float()
            # LoRA 合并：W' = W + scale * (B @ A)
            lora_key = "base_model.model." + name[:-len(".weight")].replace(".base_layer", "")
            if lora_key in lora_names:
                A = lora_state[f"{lora_key}.lora_A.weight"]  # [r, in]
                B = lora_state[f"{lora_key}.lora_B.weight"]  # [out, r]
                delta = (B @ A) * scale
                w = w + delta.to(w.dtype)
            buf[save_name] = w.to(torch.bfloat16)
        else:
            buf[save_name] = p.data.to(torch.bfloat16)
        idx += 1
        if idx % per_batch == 0:
            flush()
    flush()
    print("合并+保存完成", round(time.time() - t0), "s")

    # 4. index.json + config.json（bf16，去量化配置）
    with open(os.path.join(BASE_MODEL, "config.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["torch_dtype"] = "bfloat16"
    for k in ["quantization_config", "quant_method"]:
        cfg.pop(k, None)
    with open(os.path.join(OUT_DIR, "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT_DIR, "model.safetensors.index.json"), "w", encoding="utf-8") as f:
        total = sum(os.path.getsize(os.path.join(OUT_DIR, p)) for p in weight_map.values())
        json.dump({"metadata": {"total_size": total}, "weight_map": weight_map}, f, ensure_ascii=False, indent=2)
    print("index/config 写入完成 ->", OUT_DIR)


if __name__ == "__main__":
    main()
