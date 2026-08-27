"""
train_qa.py - 医学问答 LoRA 微调（真实质控规则 + 书籍问答数据）
基座: Qwen2.5-7B-Instruct，4bit LoRA，输出 adapter 到 output/exp-qa/
用法: python train_qa.py
"""
import os, json, sys
os.environ["HF_HUB_DISABLE_XET"] = "1"
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

from unsloth import FastLanguageModel, is_bfloat16_supported
from unsloth.chat_templates import get_chat_template
from transformers import TrainingArguments
from trl import SFTTrainer
from datasets import Dataset

BASE_MODEL = r"D:\models\Qwen2.5-7B-Instruct"
DATA_FILE = os.path.join(os.path.dirname(__file__), "qa_data", "qa_dataset.jsonl")
OUT_DIR = os.path.join(os.path.dirname(__file__), "output", "exp-qa")

def load_data():
    rows = []
    with open(DATA_FILE, encoding="utf-8") as f:
        for line in f:
            x = json.loads(line)
            rows.append({"instruction": x["instruction"], "output": x["output"]})
    return rows

def main():
    rows = load_data()
    print(f"训练样本数: {len(rows)}")
    if len(rows) == 0:
        print("无数据，退出"); sys.exit(1)

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=BASE_MODEL,
        max_seq_length=1024,
        dtype=None,
        load_in_4bit=True,
    )
    model = FastLanguageModel.get_peft_model(
        model,
        r=16, target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_alpha=16, lora_dropout=0, bias="none", use_gradient_checkpointing="unsloth",
        random_state=42, use_rslora=True, loftq_config=None,
    )
    tokenizer = get_chat_template(tokenizer, chat_template="qwen-2.5")

    def fmt(example):
        conv = [
            {"role": "user", "content": example["instruction"]},
            {"role": "assistant", "content": example["output"]},
        ]
        return {"text": tokenizer.apply_chat_template(conv, tokenize=False, add_generation_prompt=False)}

    dataset = Dataset.from_list(rows).map(fmt)

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=dataset,
        dataset_text_field="text",
        max_seq_length=1024,
        dataset_num_proc=2,
        packing=False,
        args=TrainingArguments(
            per_device_train_batch_size=2,
            gradient_accumulation_steps=4,
            warmup_steps=10,
            num_train_epochs=3,
            learning_rate=2e-4,
            fp16=not is_bfloat16_supported(),
            bf16=is_bfloat16_supported(),
            logging_steps=10,
            optim="adamw_8bit",
            weight_decay=0.01,
            lr_scheduler_type="linear",
            seed=42,
            output_dir=OUT_DIR,
            report_to="none",
        ),
    )
    trainer.train()
    trainer.save_model(os.path.join(OUT_DIR, "final"))
    print("训练完成，adapter 保存到", os.path.join(OUT_DIR, "final"))

if __name__ == "__main__":
    main()
