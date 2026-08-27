"""刷新 rag_verify 表的向量"""
import requests
import psycopg2
import os
import time
import sys

sys.stdout.reconfigure(encoding='utf-8')

API_KEY = os.environ.get('OPENAI_API_KEY', 'sk-xajkukuyawndozmikzohzcrxpbrutsayozztezhnfvjlpzcp')
BASE_URL = 'https://api.siliconflow.cn/v1'
MODEL = 'BAAI/bge-m3'

def get_embedding(text):
    r = requests.post(
        f'{BASE_URL}/embeddings',
        headers={'Authorization': f'Bearer {API_KEY}'},
        json={'model': MODEL, 'input': text}
    )
    if r.status_code == 200:
        return r.json()['data'][0]['embedding']
    elif r.status_code == 429:
        print('  API限流，等待10秒...')
        time.sleep(10)
        return get_embedding(text)
    else:
        raise Exception(f'API error {r.status_code}: {r.text}')

conn = psycopg2.connect(host='localhost', port=5433, dbname='rag', user='postgres', password='postgres')
cur = conn.cursor()

cur.execute('SELECT id, txt FROM data.rag_verify ORDER BY id')
rows = cur.fetchall()
print(f'总共 {len(rows)} 条 verify 记录')

for i, (vid, txt) in enumerate(rows):
    try:
        embedding = get_embedding(txt)
        cur.execute('UPDATE data.rag_verify SET embedding = %s::vector WHERE id = %s', (embedding, vid))
        conn.commit()
        print(f'  [{i+1}/{len(rows)}] id={vid} done')
        time.sleep(0.5)
    except Exception as e:
        print(f'  [{i+1}/{len(rows)}] id={vid} FAILED: {e}')

print('完成')
cur.close()
conn.close()
