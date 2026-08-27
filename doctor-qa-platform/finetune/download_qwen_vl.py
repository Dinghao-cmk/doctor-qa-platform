"""download_qwen_vl.py - 断点续传下载 Qwen2.5-VL-3B-Instruct（hf-mirror，失败自动重试）"""
import os
import time

os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
os.environ["HF_HUB_DISABLE_XET"] = "1"  # hf-mirror 的 xet/CAS 存储返回 401，禁用走普通 LFS

from huggingface_hub import snapshot_download  # noqa: E402

TARGET = r"D:\models\Qwen2.5-VL-3B-Instruct"
for attempt in range(1, 6):
    try:
        print(f"[尝试 {attempt}/5] 开始...")
        p = snapshot_download(
            repo_id="Qwen/Qwen2.5-VL-3B-Instruct",
            local_dir=TARGET,
            max_workers=2,
            etag_timeout=300,
            resume_download=True,
        )
        print("下载完成:", p)
        break
    except Exception as e:
        print(f"[尝试 {attempt}/5] 失败: {type(e).__name__}: {str(e)[:150]}")
        if attempt < 5:
            print("等待 5 秒后重试...")
            time.sleep(5)
else:
    print("下载最终失败")
    raise SystemExit(1)
