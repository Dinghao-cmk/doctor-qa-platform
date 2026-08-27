"""verify_merged_infer.py - 用 transformers 加载 merged-bf16（CPU offload）推理，验证合并权重本身是否正确"""
import os
import time

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
import torch

MERGED = r"C:\在水医方\doctor-qa-platform\finetune\output\merged-bf16"
t0 = time.time()

from transformers import AutoModelForCausalLM, AutoTokenizer

tok = AutoTokenizer.from_pretrained(MERGED)
model = AutoModelForCausalLM.from_pretrained(MERGED, device_map="auto", torch_dtype=torch.float32)
print("模型加载完成", round(time.time() - t0), "s", flush=True)

messages = [
    {"role": "system", "content": "你是一位专业的医学知识问答助手，服务于临床医生。回答必须严格基于提供的参考资料，每个要点标注 [参考N]，不编造、不补充资料外的内容，不确定处如实说明。"},
    {"role": "user", "content": "## 参考资料\n【参考1】《内科学第10版》肺炎\n社区获得性肺炎的诊断标准：①社区发病；②发热≥38℃；③咳嗽、咳痰或呼吸道症状加重。\n\n## 问题\n社区获得性肺炎的诊断标准是什么？"},
]
text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
inputs = tok([text], return_tensors="pt")
out = model.generate(**inputs, max_new_tokens=80, do_sample=False)
answer = tok.decode(out[0][inputs.input_ids.shape[1]:], skip_special_tokens=True)
print("=== 合并模型推理结果 ===", flush=True)
print(answer, flush=True)
print("=== 耗时", round(time.time() - t0), "s ===", flush=True)
