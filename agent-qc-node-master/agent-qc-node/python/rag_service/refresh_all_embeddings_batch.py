# -*- coding: utf-8 -*-
"""批量刷新 rag_passage + rag_verify 的真实 embedding（老板验收前必跑）
- 硅基流动 bge-m3，批量 16 条/请求
- 429 限流自动等待重试
"""
import json
import sys
import time
import urllib.request

import psycopg2

sys.stdout.reconfigure(encoding="utf-8")

API_KEY = "sk-xajkukuyawndozmikzohzcrxpbrutsayozztezhnfvjlpzcp"
BASE_URL = "https://api.siliconflow.cn/v1"
MODEL = "BAAI/bge-m3"
BATCH = 16
DB_PORT = 5433


def get_embeddings(texts):
    """批量生成 embedding，429 限流自动等待重试"""
    for attempt in range(10):
        req = urllib.request.Request(
            f"{BASE_URL}/embeddings",
            data=json.dumps({"input": texts, "model": MODEL}).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {API_KEY}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return [d["embedding"] for d in data["data"]]
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print(f"  429限流，等待10秒重试 (attempt {attempt+1})...")
                time.sleep(10)
            else:
                raise
    raise RuntimeError("限流重试次数耗尽")


def refresh_table(cur, table, id_col, text_col, conn):
    """刷新单张表的 embedding"""
    cur.execute(f"SELECT {id_col}, {text_col} FROM data.{table} ORDER BY {id_col}")
    rows = cur.fetchall()
    total = len(rows)
    print(f"[{table}] 共 {total} 条，开始批量刷新 (batch={BATCH})...")

    done = 0
    failed = 0
    for i in range(0, total, BATCH):
        chunk = rows[i : i + BATCH]
        try:
            embs = get_embeddings([r[1] for r in chunk])
            for (rid, _), emb in zip(chunk, embs):
                cur.execute(
                    f"UPDATE data.{table} SET embedding = %s::vector WHERE {id_col} = %s",
                    (emb, rid),
                )
            conn.commit()
            done += len(chunk)
            if (i // BATCH + 1) % 5 == 0 or i + BATCH >= total:
                print(f"  [{i+len(chunk)}/{total}] done={done} failed={failed}")
        except Exception as e:
            failed += len(chunk)
            print(f"  批次 {i//BATCH+1} FAILED: {e}")
            conn.rollback()
        time.sleep(0.3)  # 温和限速

    print(f"[{table}] 完成: done={done} failed={failed} total={total}")


def main():
    conn = psycopg2.connect(
        host="localhost", port=DB_PORT, dbname="rag",
        user="postgres", password="postgres",
    )
    cur = conn.cursor()

    refresh_table(cur, "rag_passage", "id", "content", conn)
    refresh_table(cur, "rag_verify", "id", "txt", conn)

    # 验证
    cur.execute("SELECT count(*) FROM data.rag_passage WHERE embedding IS NOT NULL")
    p = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM data.rag_verify WHERE embedding IS NOT NULL")
    v = cur.fetchone()[0]
    print(f"\n验证: rag_passage={p}, rag_verify={v}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
