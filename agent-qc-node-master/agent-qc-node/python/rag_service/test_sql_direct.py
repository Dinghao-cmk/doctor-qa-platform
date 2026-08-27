"""直接测试 PageIndex SQL 查询"""
import psycopg2
import requests
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

# 生成查询向量
api_key = os.environ.get('OPENAI_API_KEY', 'sk-xajkukuyawndozmikzohzcrxpbrutsayozztezhnfvjlpzcp')
r = requests.post(
    'https://api.siliconflow.cn/v1/embeddings',
    headers={'Authorization': f'Bearer {api_key}'},
    json={'model': 'BAAI/bge-m3', 'input': '肺炎诊断标准'}
)
query_embedding = r.json()['data'][0]['embedding']
print(f"查询向量维度: {len(query_embedding)}")
print(f"前5个值: {query_embedding[:5]}")

# 连接数据库测试 SQL
conn = psycopg2.connect(host='localhost', port=5433, dbname='rag', user='postgres', password='postgres')
cur = conn.cursor()

# 测试1: 检查 doc_id=210 的数据
cur.execute("SELECT COUNT(*) FROM data.rag_passage WHERE doc_id = 210")
print(f"\ndoc_id=210 的段落数: {cur.fetchone()[0]}")

# 测试2: 直接计算相似度（不设阈值）
sql = """
    SELECT p.id, p.section_path, 1 - (p.embedding <=> %s::vector) AS similarity
    FROM data.rag_passage p
    WHERE p.doc_id = 210 AND p.enabled = true
    ORDER BY p.embedding <=> %s::vector
    LIMIT 3
"""
cur.execute(sql, (query_embedding, query_embedding))
rows = cur.fetchall()
print(f"\n相似度最高的3个段落:")
for row in rows:
    print(f"  id={row[0]}, path={row[1][:30]}, similarity={row[2]:.4f}")

# 测试3: 用阈值 0.3 过滤
sql2 = """
    SELECT COUNT(*)
    FROM data.rag_passage p
    WHERE p.doc_id = 210 AND p.enabled = true
      AND 1 - (p.embedding <=> %s::vector) >= 0.3
"""
cur.execute(sql2, (query_embedding,))
count = cur.fetchone()[0]
print(f"\n相似度 >= 0.3 的段落数: {count}")

cur.close()
conn.close()
