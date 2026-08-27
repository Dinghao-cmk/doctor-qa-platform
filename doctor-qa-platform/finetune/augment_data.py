# -*- coding: utf-8 -*-
"""
augment_data.py - 训练数据规则化增强（保守三手法中的两个安全维度）
手法1 问题改写：同义句式转述（"是什么"→"包括哪些内容"等），仅替换问法虚词，医学语义不变
手法2 输出格式改写：列表式 ↔ 段落式互转 / 数字列表 → 符号列表，医学内容与 [参考N] 原样保留
不新增任何医学事实，不改变参考资料内容 —— 保证增强样本与原样本答案等价
输出：rag_train_v4.jsonl（原始 + 成功生成的变体）；统计报告：augment_report.txt
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "rag_train_v3.jsonl")
DST = os.path.join(HERE, "rag_train_v4.jsonl")
REPORT = os.path.join(HERE, "augment_report.txt")

# ---------------- 手法1：问题改写模板（顺序匹配，先长后短） ----------------
def _how_repl(m):
    """'X如何Y' -> 'X应该怎样Y'；去掉 head 尾部粘连的'应/，/、'避免'应应'重复"""
    head = m.group("head").rstrip("应，,、")
    return f"{head}应该怎样{m.group('tail')}？"


def _why_repl(m):
    return f"{m.group('tail')}的原因是什么？"


Q_REFORM = [
    (re.compile(r"^(?P<head>.+?)(?:的)?典型临床表现是什么[?？]?$"), r"\g<head>的典型临床表现包括哪些内容？"),
    (re.compile(r"^(?P<head>.+?)多重用药的界定标准是什么[?？]?$"), r"\g<head>多重用药的界定标准包括哪些内容？"),
    (re.compile(r"^(?P<head>.+?)的推荐是什么[?？]?$"), r"\g<head>的建议包括哪些？"),
    (re.compile(r"^(?P<head>.+?)的诊断标准是什么[?？]?$"), r"\g<head>的诊断标准包括哪些？"),
    (re.compile(r"^(?P<head>.+?)的界定标准是什么[?？]?$"), r"\g<head>的界定标准包括哪些内容？"),
    (re.compile(r"^(?P<head>.+?)的标准是什么[?？]?$"), r"\g<head>的标准包括哪些内容？"),
    (re.compile(r"^(?P<head>.+?)分别是什么[?？]?$"), r"\g<head>分别包括哪些？"),
    (re.compile(r"^(?P<head>.+?)是什么[?？]?$"), r"\g<head>包括哪些内容？"),
    (re.compile(r"^(?P<head>.+?)有哪些[?？]?$"), r"\g<head>包括哪些？"),
    (re.compile(r"^(?P<head>.+?)包括哪些[?？]?$"), r"\g<head>有哪些？"),
    (re.compile(r"^(?P<head>.+?)有哪几(?:类|种)[?？]?$"), lambda m: f"{m.group('head')}分为哪几类？"),
    (re.compile(r"^(?P<head>.+?)有什么作用[?？]?$"), r"\g<head>的作用包括哪些？"),
    (re.compile(r"^(?P<head>.+?)有什么限制[?？]?$"), r"\g<head>的限制包括哪些？"),
    (re.compile(r"^(?P<head>.+?)有何临床获益[?？]?$"), r"\g<head>的临床获益包括哪些？"),
    (re.compile(r"^(?P<head>.+?)有哪些临床获益[?？]?$"), r"\g<head>的临床获益包括哪些？"),
    (re.compile(r"^(?P<head>.+?)的临床获益有哪些[?？]?$"), r"\g<head>有哪些临床获益？"),
    (re.compile(r"^(?P<head>.+?)有何区别[?？]?$"), r"\g<head>有什么区别？"),
    (re.compile(r"^(?P<head>.+?)包括哪几(?:种|类)类型[?？]?$"), lambda m: f"{m.group('head')}分为哪几种？"),
    (re.compile(r"^(?P<head>.+?)分别是多少[?？]?$"), r"\g<head>各是多少？"),
    (re.compile(r"^(?P<head>.+?)是多少[?？]?$"), r"\g<head>分别是多少？"),
    (re.compile(r"^(?P<head>.+?)是怎样的[?？]?$"), r"\g<head>是什么？"),
    (re.compile(r"^(?P<head>.+?)宜选用哪类(?P<tail>.+?)[?？]?$"), r"\g<head>应该选用哪一类\g<tail>？"),
    (re.compile(r"^(?P<head>.+?)需要覆盖哪些(?P<tail>.+?)[?？]?$"), r"\g<head>应覆盖哪些\g<tail>？"),
    (re.compile(r"^(?P<head>.+?)能发挥什么作用[?？]?$"), r"\g<head>能发挥哪些作用？"),
    (re.compile(r"^(?P<head>.+?)应遵循什么原则[?？]?$"), r"\g<head>应遵循哪些原则？"),
    (re.compile(r"^(?P<head>.+?)哪个(?P<tail>.+?)[?？]?$"), r"\g<head>哪一个\g<tail>？"),
    (re.compile(r"^(?P<head>.+?)可能导致哪些(?P<tail>.+?)[?？]?$"), r"\g<head>可能带来哪些\g<tail>？"),
    (re.compile(r"^(?P<head>.+?)有哪些影响[?？]?$"), r"\g<head>的影响包括哪些？"),
    (re.compile(r"^(?P<head>.+?)属于哪一类(?P<tail>.+?)[?？]?$"), r"\g<head>属于哪个类别\g<tail>？"),
    (re.compile(r"^(?P<head>.+?)有何特点[?？]?$"), r"\g<head>的特点包括哪些？"),
    (re.compile(r"^(?P<head>.+?)是否存在显著差异[?？]?$"), r"\g<head>是否存在明显差异？"),
    (re.compile(r"^(?P<head>.+?)具有怎样的(?P<tail>.+?)[?？]?$"), r"\g<head>的\g<tail>如何？"),
    (re.compile(r"^(?P<head>.+?)能否(?P<tail>.+?)[?？]?$"), r"\g<head>是否可用于\g<tail>？"),
    (re.compile(r"^(?P<head>.+?)应出现哪些(?P<tail>.+?)[?？]?$"), r"\g<head>会出现哪些\g<tail>？"),
    (re.compile(r"^(?P<head>.+?)主要依据哪些(?P<tail>.+?)[?？]?$"), r"\g<head>依据哪些\g<tail>？"),
    (re.compile(r"^(?P<head>.+?)需要考虑哪些(?P<tail>.+?)[?？]?$"), r"\g<head>需考虑哪些\g<tail>？"),
    (re.compile(r"^如何(?P<tail>.+?)[?？]?$"), r"应该怎样\g<tail>？"),
    (re.compile(r"^怎么(?P<tail>.+?)[?？]?$"), r"应如何\g<tail>？"),
    (re.compile(r"^(?P<head>.+?)(?:应)?如何(?P<tail>.+?)[?？]?$"), _how_repl),
    (re.compile(r"^为什么(?P<tail>.+?)[?？]?$"), _why_repl),
]

# ---------------- 手法2：输出格式改写 ----------------
BULLET_RE = re.compile(r"^[-•]\s*(.+)$")
NUMBER_RE = re.compile(r"^\d+[.、]\s*(.+)$")


def _join_items(items):
    """条目列表 -> 段落式文本（保 [参考N]）"""
    text = "；".join(items)
    if not text.endswith(("。", "；")):
        text += "。"
    return text


# ---------------- 手法2：输出格式改写 ----------------
BULLET_RE = re.compile(r"^[-•]\s*(.+)$")
NUMBER_RE = re.compile(r"^\d+[.、]\s*(.+)$")


def reform_output(out: str):
    """返回改写后的 output；无法安全改写返回 None
    支持：纯列表 -> 段落式；数字列表 -> 符号列表；引导行+列表（混合式）-> 引导行+转换后列表
    """
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    if not lines:
        return None
    # 找列表块：从最后一行往前，连续 bullet/数字 行
    list_start = None
    for i in range(len(lines) - 1, -1, -1):
        if BULLET_RE.match(lines[i]) or NUMBER_RE.match(lines[i]):
            list_start = i
        else:
            break
    if list_start is None:
        return None
    list_lines = lines[list_start:]
    is_number = all(NUMBER_RE.match(l) for l in list_lines)
    is_bullet = all(BULLET_RE.match(l) for l in list_lines)
    prefix = lines[:list_start]
    if is_number:
        # 数字列表 -> 符号列表
        new_list = "\n".join("- " + NUMBER_RE.match(l).group(1).strip() for l in list_lines)
    elif is_bullet and not prefix:
        # 纯符号列表 -> 段落式
        items = [BULLET_RE.match(l).group(1).strip() for l in list_lines]
        return _join_items(items)
    elif is_bullet and len(prefix) == 1 and prefix[0].endswith("："):
        # 引导行（以：结尾）+ 符号列表 -> 引导行 + 段落式（如 "包括：\n- a\n- b" -> "包括：a；b。"）
        items = [BULLET_RE.match(l).group(1).strip() for l in list_lines]
        return prefix[0] + _join_items(items)
    else:
        return None  # 其他混合式：保守跳过
    return "\n".join(prefix + [new_list])


def reform_question(q: str):
    """返回改写后的问题；无匹配返回 None"""
    q = q.strip()
    for pat, repl in Q_REFORM:
        m = pat.match(q)
        if m:
            new_q = pat.sub(repl, q)
            if new_q != q:
                return new_q
    return None


def main():
    stats = {"原始": 0, "问题改写": 0, "输出改写": 0, "问题未匹配": 0, "输出无法改写": 0}
    out_lines = []
    with open(SRC, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            s = json.loads(line)
            stats["原始"] += 1
            out_lines.append(json.dumps(s, ensure_ascii=False))
            # 变体A：问题改写（input 内替换 ## 问题 行）
            m = re.search(r"## 问题\n(.+)$", s["input"])
            if m:
                new_q = reform_question(m.group(1))
                if new_q:
                    v1 = dict(s)
                    v1["input"] = s["input"][: m.start(1)] + new_q
                    out_lines.append(json.dumps(v1, ensure_ascii=False))
                    stats["问题改写"] += 1
                else:
                    stats["问题未匹配"] += 1
            # 变体B：输出格式改写
            new_out = reform_output(s["output"])
            if new_out:
                v2 = dict(s)
                v2["output"] = new_out
                out_lines.append(json.dumps(v2, ensure_ascii=False))
                stats["输出改写"] += 1
            else:
                stats["输出无法改写"] += 1

    with open(DST, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines) + "\n")

    report = []
    report.append(f"输入: {SRC}")
    report.append(f"输出: {DST}")
    report.append(f"总样本: {stats['原始']} -> {len(out_lines)} 条（{len(out_lines) / stats['原始']:.2f} 倍）")
    for k, v in stats.items():
        report.append(f"  {k}: {v}")
    report.append("")
    report.append("问题改写示例：")
    with open(SRC, "r", encoding="utf-8") as f:
        shown = 0
        for line in f:
            s = json.loads(line)
            m = re.search(r"## 问题\n(.+)$", s["input"])
            if m:
                new_q = reform_question(m.group(1))
                if new_q and shown < 8:
                    report.append(f"  {m.group(1)}  ->  {new_q}")
                    shown += 1
    report.append("")
    report.append("问题未匹配示例（前15条）：")
    with open(SRC, "r", encoding="utf-8") as f:
        shown = 0
        for line in f:
            s = json.loads(line)
            m = re.search(r"## 问题\n(.+)$", s["input"])
            if m and not reform_question(m.group(1)) and shown < 15:
                report.append(f"  {m.group(1)}")
                shown += 1
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write("\n".join(report))
    print("\n".join(report))


if __name__ == "__main__":
    main()

