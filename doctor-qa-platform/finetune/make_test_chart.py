# -*- coding: utf-8 -*-
"""make_test_chart.py - 生成多模态测试图（模拟检验单 + 心电图）
内容可控，用于验证 VL 模型是否真正读懂图片
"""
from PIL import Image, ImageDraw, ImageFont
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = r"C:\Windows\Fonts\msyh.ttc"  # 微软雅黑


def find_font(size):
    for p in [FONT, r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simsun.ttc"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def make_lab_report(path):
    """模拟检验报告单：血常规 + 肝肾功能，其中 2 项异常（高亮）"""
    W, H = 620, 460
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    f_title = find_font(28)
    f_head = find_font(20)
    f_body = find_font(18)

    d.text((20, 15), "XX市人民医院检验报告单", fill="black", font=f_title)
    d.text((20, 65), "姓名：王某  性别：男  年龄：52岁  科室：心内科", fill="black", font=f_head)
    d.line([(20, 105), (W - 20, 105)], fill="black", width=2)

    rows = [
        ("项目", "结果", "单位", "参考范围"),
        ("白细胞计数", "6.8", "10^9/L", "3.5-9.5"),
        ("血红蛋白", "142", "g/L", "130-175"),
        ("血小板计数", "238", "10^9/L", "125-350"),
        ("ALT（谷丙转氨酶）", "78", "U/L", "9-50"),
        ("AST（谷草转氨酶）", "64", "U/L", "15-40"),
        ("肌酐", "88", "umol/L", "57-97"),
        ("血糖", "5.6", "mmol/L", "3.9-6.1"),
        ("总胆固醇", "6.8", "mmol/L", "2.8-5.2"),
    ]
    y = 120
    for i, row in enumerate(rows):
        if i == 0:
            d.rectangle([(20, y), (W - 20, y + 34)], fill="#E8E8E8")
        else:
            abnormal = row[1] in ("78", "64", "6.8") and row[0] != "血糖"
            if abnormal:
                d.rectangle([(20, y), (W - 20, y + 34)], fill="#FFECEC")
        x_off = 20
        for j, cell in enumerate(row):
            fill = "red" if (i > 0 and cell in ("78", "64") or (i == 8 and cell == "6.8")) else "black"
            d.text((x_off + 10, y + 6), cell, fill=fill, font=f_body)
            x_off += 150 if j == 0 else (80 if j == 2 else 90)
        y += 38
    d.text((20, H - 40), "检验医师：李XX    报告时间：2026-08-20 09:15", fill="black", font=f_body)
    img.save(path)
    print(f"检验单已生成: {path}")


def make_ecg(path):
    """模拟心电图：一段正常窦性心律波形（P波/QRS/T波 手绘示意）"""
    W, H = 900, 400
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    # 网格
    for x in range(0, W, 25):
        d.line([(x, 0), (x, H)], fill="#F0F0F0", width=1)
    for y in range(0, H, 25):
        d.line([(0, y), (W, y)], fill="#F0F0F0", width=1)
    for x in range(0, W, 125):
        d.line([(x, 0), (x, H)], fill="#E0E0E0", width=2)

    mid = H // 2
    pts = []
    x = 0
    while x < W:
        # P 波
        for t in range(20):
            pts.append((x + t, mid - 12 * math.sin(math.pi * t / 19)))
        x += 20
        # PR 段
        for t in range(10):
            pts.append((x + t, mid))
        x += 10
        # QRS 波
        pts.append((x + 6, mid))
        pts.append((x + 12, mid - 45))
        pts.append((x + 18, mid + 20))
        x += 24
        # ST 段 + T 波
        for t in range(15):
            pts.append((x + t, mid))
        x += 15
        for t in range(30):
            pts.append((x + t, mid - 18 * math.sin(math.pi * t / 29)))
        x += 30
        # TP 段
        for t in range(40):
            pts.append((x + t, mid))
        x += 40

    d.line(pts, fill="blue", width=2)
    d.text((20, 20), "12导联心电图  I导联  走纸速度25mm/s  增益10mm/mV", fill="black", font=find_font(18))
    img.save(path)
    print(f"心电图已生成: {path}")


if __name__ == "__main__":
    make_lab_report(os.path.join(HERE, "test_lab.png"))
    make_ecg(os.path.join(HERE, "test_ecg.png"))
