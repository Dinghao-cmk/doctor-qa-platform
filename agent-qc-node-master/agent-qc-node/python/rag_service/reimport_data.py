"""重新导入多本书数据 - 修复中文编码"""
import os
import psycopg2
import sys

from config import parse_conn_str

sys.stdout.reconfigure(encoding='utf-8')

DEFAULT_CONN_STR = "postgres:postgres@localhost:5433/rag"


def get_conn_params():
    """从环境变量读取数据库连接串并解析"""
    conn_str = os.environ.get("RAG_DB_CONN_STR", DEFAULT_CONN_STR)
    params = parse_conn_str(conn_str)
    if "user" not in params:
        params["user"] = "postgres"
    return params


SQL_FILE = r'c:\在水医方\agent-qc-node-master\agent-qc-node\sql\multi_book_benchmark.sql'

# 读取SQL文件
with open(SQL_FILE, 'r', encoding='utf-8') as f:
    sql_content = f.read()

# 连接数据库
conn = psycopg2.connect(**get_conn_params())
cur = conn.cursor()

# 先清空旧数据
print("清空旧数据...")
cur.execute("DELETE FROM data.rag_relationship")
cur.execute("DELETE FROM data.rag_community")
cur.execute("DELETE FROM data.rag_entity")
cur.execute("DELETE FROM data.rag_passage WHERE id >= 10000")
cur.execute("DELETE FROM data.rag_rule_doc_map WHERE doc_id >= 100")
cur.execute("DELETE FROM data.rag_source_doc WHERE id >= 100")
conn.commit()

# 执行SQL
print("导入数据...")
try:
    cur.execute(sql_content)
    conn.commit()
    print("导入成功")
except Exception as e:
    print(f"导入失败: {e}")
    conn.rollback()

# 验证
cur.execute("SELECT COUNT(*) FROM data.rag_passage WHERE id >= 10000")
passage_count = cur.fetchone()[0]
print(f"段落数: {passage_count}")

cur.execute("SELECT id, title, node_path FROM data.rag_source_doc WHERE id >= 100 ORDER BY id LIMIT 5")
print("\n书籍列表:")
for row in cur.fetchall():
    print(f"  id={row[0]}, title={row[1]}, path={row[2]}")

cur.execute("SELECT DISTINCT section_path FROM data.rag_passage WHERE doc_id = 210 LIMIT 1")
path = cur.fetchone()[0]
print(f"\n肺炎路径示例: {path}")

cur.close()
conn.close()
