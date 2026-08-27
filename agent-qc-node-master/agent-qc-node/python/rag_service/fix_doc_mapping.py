"""修复 doc_id_mapping.json - 用精确的最后一段匹配"""
import json
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

working_dir = "./lightrag_data"

# 1. 读取 full_docs
full_docs_path = os.path.join(working_dir, "kv_store_full_docs.json")
with open(full_docs_path, 'r', encoding='utf-8') as f:
    full_docs = json.load(f)

# 构建 file_path -> lightrag_doc_id 映射
fp_to_lr_id = {}
for lr_id, data in full_docs.items():
    fp = data.get("file_path", "")
    if fp:
        fp_to_lr_id[fp] = lr_id

print(f"full_docs 共 {len(full_docs)} 条, 唯一 file_path {len(fp_to_lr_id)} 个")

# 2. 读取旧映射
old_mapping_path = os.path.join(working_dir, "doc_id_mapping.json")
with open(old_mapping_path, 'r', encoding='utf-8') as f:
    old_mapping = json.load(f)

# 3. 精确匹配：取 old_fp 的最后一段（去掉尾部斜杠）
new_mapping = {}
unmatched = []

for sql_doc_id, entry in old_mapping.items():
    old_fp = entry.get("file_path", "").rstrip("/")
    # 取最后一段
    last_segment = old_fp.split("/")[-1] if "/" in old_fp else old_fp
    
    # 精确匹配
    if last_segment in fp_to_lr_id:
        new_mapping[sql_doc_id] = {
            "file_path": entry.get("file_path", ""),
            "lightrag_doc_id": fp_to_lr_id[last_segment]
        }
    else:
        unmatched.append((sql_doc_id, old_fp, last_segment))

print(f"\n精确匹配成功: {len(new_mapping)} 条")
if unmatched:
    print(f"未匹配: {len(unmatched)} 条:")
    for sql_id, old_fp, last_seg in unmatched:
        print(f"  SQL {sql_id}: {old_fp} (last={last_seg})")

# 4. 保存
with open(old_mapping_path, 'w', encoding='utf-8') as f:
    json.dump(new_mapping, f, ensure_ascii=False, indent=2)

print(f"\n修复后映射:")
for sql_id, entry in sorted(new_mapping.items(), key=lambda x: int(x[0])):
    print(f"  SQL {sql_id}: {entry['file_path']} -> {entry['lightrag_doc_id']}")

print(f"\n已保存")
