"""刷新编码规则段落的向量 - 直接调用硅基流动API"""
import requests
import psycopg2
import os

# 硅基流动API配置
API_KEY = os.environ.get('OPENAI_API_KEY', 'sk-xajkukuyawndozmikzohzcrxpbrutsayozztezhnfvjlpzcp')
BASE_URL = 'https://api.siliconflow.cn/v1'
MODEL = 'BAAI/bge-m3'

def get_embedding(text):
    """调用硅基流动API生成embedding"""
    r = requests.post(
        f'{BASE_URL}/embeddings',
        headers={'Authorization': f'Bearer {API_KEY}'},
        json={'model': MODEL, 'input': text}
    )
    if r.status_code == 200:
        return r.json()['data'][0]['embedding']
    else:
        raise Exception(f'API error: {r.text}')

# 连接数据库
conn = psycopg2.connect(host='localhost', port=5433, dbname='rag', user='postgres', password='rag123')
cur = conn.cursor()

# 查询需要刷新的段落
cur.execute('SELECT id, content FROM data.rag_passage WHERE doc_id >= 300 AND embedding IS NULL')
rows = cur.fetchall()
print(f'需要刷新: {len(rows)} 个段落')

# 生成embedding并更新
count = 0
for pid, content in rows:
    try:
        emb = get_embedding(content)
        cur.execute('UPDATE data.rag_passage SET embedding = %s WHERE id = %s', (emb, pid))
        count += 1
        print(f'  [{count}] passage_id={pid} done')
    except Exception as e:
        print(f'  [FAIL] passage_id={pid}: {e}')

conn.commit()
print(f'刷新完成: {count} 个段落')

# 验证
cur.execute('''
    SELECT id, doc_id, LEFT(section_path, 30), 
           CASE WHEN embedding IS NOT NULL THEN 'YES' ELSE 'NO' END 
    FROM data.rag_passage WHERE doc_id >= 300 ORDER BY id
''')
for row in cur.fetchall():
    print(f'  id={row[0]} doc_id={row[1]} path={row[2]}... embedding={row[3]}')

conn.close()
