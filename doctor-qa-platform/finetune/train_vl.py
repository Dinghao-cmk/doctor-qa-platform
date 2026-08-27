# -*- coding: utf-8 -*-
"""
train_vl.py - LoRA 微调 Qwen2.5-VL-3B：检验单判读（看图表回答异常项目）
数据：vl_data/vl_dataset.jsonl（60 张训练图，image + conversations 格式）
用法：python train_vl.py
"""
import os
import json
from datasets import Dataset
from unsloth import FastVisionModel, UnslothVisionDataCollator
from unsloth import is_bfloat16_supported
from transformers import TrainingArguments, AutoProcessor
from trl import SFTTrainer

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_MODEL = r"D:\models\Qwen2.5-VL-3B-Instruct"
DATA_FILE = os.path.join(HERE, "vl_data", "vl_dataset.jsonl")
OUT_DIR = os.path.join(HERE, "output", "exp-vl-r4")

MAX_SEQ = 1024
LORA_R = 8
EPOCHS = 6


def load_jsonl(path):
    """读 jsonl，把 <image> 标记转成 content 数组（qwen-vl 标准格式）"""
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            img = row["image"]  # 保留顶层字段，供 Unsloth 识别为视觉数据集
            for m in row["conversations"]:
                if m["role"] == "user" and m["content"].startswith("<image>"):
                    text = m["content"].replace("<image>\n", "").replace("<image>", "")
                    m["content"] = [
                        {"type": "image", "image": img},
                        {"type": "text", "text": text},
                    ]
                elif isinstance(m["content"], str):
                    m["content"] = [{"type": "text", "text": m["content"]}]
            rows.append(row)
    return rows


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    model, tokenizer = FastVisionModel.from_pretrained(
        BASE_MODEL,
        load_in_4bit=True,
        dtype=None,
    )
    model = FastVisionModel.get_peft_model(
        model,
        r=LORA_R,
        lora_alpha=2 * LORA_R,
        lora_dropout=0,
        use_gradient_checkpointing="unsloth",
        random_state=42,
    )

    data = load_jsonl(DATA_FILE)
    dataset = Dataset.from_list(data)

    processor = AutoProcessor.from_pretrained(BASE_MODEL)
    data_collator = UnslothVisionDataCollator(model=model, processor=processor)

    args = TrainingArguments(
        per_device_train_batch_size=2,
        gradient_accumulation_steps=2,
        warmup_steps=5,
        num_train_epochs=EPOCHS,
        learning_rate=2e-4,
        fp16=not is_bfloat16_supported(),
        bf16=is_bfloat16_supported(),
        logging_steps=1,
        optim="adamw_8bit",
        weight_decay=0.01,
        lr_scheduler_type="linear",
        seed=3407,
        output_dir=OUT_DIR,
        report_to="none",
        dataloader_num_workers=0,
        save_strategy="epoch",
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        data_collator=data_collator,
        train_dataset=dataset,
        args=args,
        formatting_func=lambda example: example,
    )

    trainer.train()
    trainer.save_model(os.path.join(OUT_DIR, "final"))
    print(f"训练完成，模型已保存: {os.path.join(OUT_DIR, 'final')}")


if __name__ == "__main__":
    main()
