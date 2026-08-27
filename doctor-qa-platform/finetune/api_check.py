import inspect
from unsloth import FastLanguageModel

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=r"D:\models\Qwen2.5-7B-Instruct",
    max_seq_length=1024,
    dtype=None,
    load_in_4bit=True,
)
print("=== 模型实例方法 ===")
for m in dir(model):
    if any(k in m for k in ["save", "merge", "gguf"]):
        try:
            fn = getattr(model, m)
            print(m, inspect.signature(fn) if callable(fn) else "")
        except Exception:
            print(m)
