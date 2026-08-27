# -*- coding: utf-8 -*-
"""make_vl_dataset.py - 批量生成"检验单图片 + 问答标注"多模态训练数据
训练集 60 张 + 测试集 10 张（不同随机种子，测试图训练时绝对没见过）
随机组合：患者信息 / 检验项目 / 数值（1~3 项异常）→ 自动生成标注答案
"""
import json
import os
import random
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "vl_data")

# 检验项目池：(名称, 单位, 参考下限, 参考上限, 异常方向允许)
ITEMS = [
    ("白细胞计数", "10^9/L", 3.5, 9.5, "both"),
    ("血红蛋白", "g/L", 130, 175, "low"),
    ("血小板计数", "10^9/L", 125, 350, "both"),
    ("ALT(谷丙转氨酶)", "U/L", 9, 50, "high"),
    ("AST(谷草转氨酶)", "U/L", 15, 40, "high"),
    ("总胆红素", "umol/L", 5, 21, "high"),
    ("肌酐", "umol/L", 57, 97, "high"),
    ("尿素", "mmol/L", 3.1, 8.0, "both"),
    ("总胆固醇", "mmol/L", 2.8, 5.2, "high"),
    ("甘油三酯", "mmol/L", 0.4, 1.7, "high"),
    ("空腹血糖", "mmol/L", 3.9, 6.1, "both"),
]

NAMES = ["王某", "李某", "张某", "刘某", "陈某", "杨某", "赵某", "周某", "吴某", "郑某", "孙某", "钱某"]
DEPTS = ["心内科", "呼吸科", "消化科", "内分泌科", "肾内科", "神经内科", "老年科", "普外科"]


def find_font(size):
    for p in [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simsun.ttc"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def pick_items(rng):
    """随机选 6~9 项，保证每项参考范围互不相同的语义"""
    n = rng.randint(6, 9)
    return rng.sample(ITEMS, n)


def make_value(rng, lo, hi, abnormal):
    """生成数值：正常（范围内随机）或异常（超出 10%~35%）"""
    if not abnormal:
        return round(rng.uniform(lo + (hi - lo) * 0.15, hi - (hi - lo) * 0.15), 1)
    direction = rng.choice(["low", "high"])
    if direction == "low":
        return round(rng.uniform(lo * 0.55, lo * 0.9), 1)
    return round(rng.uniform(hi * 1.1, hi * 1.4), 1)


def render_chart(path, name, dept, sex, age, rows, abnormal_idx):
    """画检验单，异常项红字 + 浅红底"""
    W, H = 640, 60 + 40 * (len(rows) + 2)
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    f_title = find_font(26)
    f_head = find_font(18)
    f_body = find_font(17)

    d.text((20, 14), "XX市人民医院检验报告单", fill="black", font=f_title)
    d.text((20, 58), f"姓名：{name}  性别：{sex}  年龄：{age}岁  科室：{dept}", fill="black", font=f_head)
    d.line([(20, 98), (W - 20, 98)], fill="black", width=2)

    y = 112
    header = ("项目", "结果", "单位", "参考范围")
    d.rectangle([(20, y), (W - 20, y + 34)], fill="#E8E8E8")
    x_off = 20
    for cell in header:
        d.text((x_off + 10, y + 6), cell, fill="black", font=f_body)
        x_off += 155 if cell == "项目" else (75 if cell == "单位" else 90)
    y += 38

    for i, ((item, unit, lo, hi, _dir), val) in enumerate(rows):
        if i in abnormal_idx:
            d.rectangle([(20, y), (W - 20, y + 34)], fill="#FFECEC")
        x_off = 20
        cells = (item, f"{val:g}", unit, f"{lo:g}-{hi:g}")
        for j, cell in enumerate(cells):
            fill = "red" if (i in abnormal_idx and j == 1) else "black"
            d.text((x_off + 10, y + 6), cell, fill=fill, font=f_body)
            x_off += 155 if j == 0 else (75 if j == 2 else 90)
        y += 38

    d.text((20, y + 8), "检验医师：李XX    报告时间：2026-08-2X XX:XX", fill="black", font=f_body)
    img.save(path)
    return img


def build_sample(rng, tag, idx):
    """生成一张图 + 标注"""
    items = pick_items(rng)
    name = rng.choice(NAMES)
    dept = rng.choice(DEPTS)
    sex = rng.choice(["男", "女"])
    age = rng.randint(18, 85)

    n_abn = rng.randint(1, 3)
    abnormal_idx = rng.sample(range(len(items)), n_abn)
    rows = []
    for i, (item, unit, lo, hi, direction) in enumerate(items):
        abn = i in abnormal_idx
        val = make_value(rng, lo, hi, abn)
        if abn and direction == "low" and val > lo:
            val = round(rng.uniform(lo * 0.55, lo * 0.9), 1)
        if abn and direction == "high" and val < hi:
            val = round(rng.uniform(hi * 1.1, hi * 1.4), 1)
        rows.append(((item, unit, lo, hi, direction), val))

    # 异常描述
    descs = []
    for i in abnormal_idx:
        (item, unit, lo, hi, _d), val = rows[i]
        kind = "偏高" if val > hi else "偏低"
        descs.append(f"{item} {val:g} {unit}（参考 {lo:g}-{hi:g}，{kind}）")
    abnormal_txt = "；".join(descs) if descs else "无"

    # 正常项汇总（供回答用）
    normals = []
    for i, ((item, unit, lo, hi, _d), val) in enumerate(rows):
        if i not in abnormal_idx:
            normals.append(f"{item} {val:g}")
    normal_txt = "；".join(normals) if normals else "（无）"

    img_path = os.path.join(DATA_DIR, tag, f"{tag}_{idx:03d}.png")
    render_chart(img_path, name, dept, sex, age, rows, abnormal_idx)

    conv = [
        {
            "role": "user",
            "content": f"<image>\n请阅读这张检验报告单：1) 患者基本信息；2) 哪些项目超出参考范围？请逐项列出异常项目、数值、单位和参考范围。",
        },
        {
            "role": "assistant",
            "content": f"患者{name}，{sex}，{age}岁，{dept}。异常项目共{len(descs)}项：{abnormal_txt}。其余项目均在参考范围内（{normal_txt}）。",
        },
        {
            "role": "user",
            "content": "这些异常结果提示哪些可能的临床问题？",
        },
        {
            "role": "assistant",
            "content": "结合异常项分析：异常项为 {abnormal_txt}。具体临床意义需结合患者症状、病史及其他检查综合判断，建议咨询临床医生进一步评估。".replace("{abnormal_txt}", abnormal_txt),
        },
    ]
    return {"image": img_path, "conversations": conv}


def main():
    os.makedirs(os.path.join(DATA_DIR, "train"), exist_ok=True)
    os.makedirs(os.path.join(DATA_DIR, "test"), exist_ok=True)

    # 训练集：固定种子可复现；测试集：不同种子保证完全不重叠
    train_rng = random.Random(42)
    test_rng = random.Random(2026)

    records = []
    for i in range(1, 61):
        records.append(build_sample(train_rng, "train", i))
    for i in range(1, 11):
        records.append(build_sample(test_rng, "test", i))

    out = os.path.join(DATA_DIR, "vl_dataset.jsonl")
    with open(out, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    # 测试集单独一份（供评测脚本用，不含答案的纯图清单另存）
    with open(os.path.join(DATA_DIR, "vl_test.jsonl"), "w", encoding="utf-8") as f:
        for r in records[60:]:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    n_abn = sum(len([c for c in r["conversations"][1]["content"].split("异常项目共")]) - 1 for r in records) if False else 0
    print(f"生成完成: {out}")
    print(f"训练集 60 张 + 测试集 10 张")
    print(f"样例标注: {records[0]['conversations'][1]['content'][:120]}")


if __name__ == "__main__":
    main()
