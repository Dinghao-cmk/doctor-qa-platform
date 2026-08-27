"""刷新所有段落的向量 - 调用硅基流动API生成真实embedding"""
import requests
import psycopg2
import os
import time
import sys

sys.stdout.reconfigure(encoding='utf-8')

# 配置
API_KEY = os.environ.get('OPENAI_API_KEY', 'sk-xajkukuyawndozmikzohzcrxpbrutsayozztezhnfvjlpzcp')
BASE_URL = 'https://api.siliconflow.cn/v1'
MODEL = 'BAAI/bge-m3'
DB_PORT = int(os.environ.get('DB_PORT', '5433'))

def get_embedding(text):
    """调用硅基流动API生成embedding"""
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

def main():
    # 连接数据库
    conn = psycopg2.connect(host='localhost', port=DB_PORT, dbname='rag', user='postgres', password='postgres')
    cur = conn.cursor()
    
    # 查询所有段落
    cur.execute('SELECT id, content FROM data.rag_passage ORDER BY id')
    rows = cur.fetchall()
    total = len(rows)
    print(f'总共 {total} 个段落需要刷新向量')
    
    success = 0
    failed = 0
    
    for i, (passage_id, content) in enumerate(rows):
        try:
            # 生成embedding
            embedding = get_embedding(content)
            
            # 更新数据库
            cur.execute('UPDATE data.rag_passage SET embedding = %s::vector WHERE id = %s', (embedding, passage_id))
            conn.commit()
            
            success += 1
            if (i + 1) % 10 == 0 or i == 0:
                print(f'  [{i+1}/{total}] id={passage_id} done (success={success}, failed={failed})')
            
            # 避免API限流
            if (i + 1) % 50 == 0:
                print(f'  已处理 {i+1} 个，暂停2秒...')
                time.sleep(2)
                
        except Exception as e:
            failed += 1
            print(f'  [{i+1}/{total}] id={passage_id} FAILED: {e}')
            continue
    
    print(f'\n刷新完成: success={success}, failed={failed}, total={total}')
    
    # 验证
    cur.execute('SELECT COUNT(*) FROM data.rag_passage WHERE embedding IS NOT NULL')
    count = cur.fetchone()[0]
    print(f'数据库中有向量的段落: {count}/{total}')
    
    cur.close()
    conn.close()

if __name__ == '__main__':
    main()
