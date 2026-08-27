"""
config.py - RAG 服务配置中心
所有环境变量统一在此解析，其他模块仅从本文件导入，不直接读 os.environ
"""
import os

# ── 数据库连接 ───────────────────────────────────────────────
# 优先读 RAG_DB_CONN_STR，未配置时回退到 ZK_DB_CONN_STR
DB_CONN_STR = os.environ.get(
    "RAG_DB_CONN_STR",
    os.environ.get("ZK_DB_CONN_STR", "rag_user:password@localhost:5432/rag"),
)

# 解析连接串为 psycopg2 参数（格式: user:password@host:port/database）
def parse_conn_str(conn_str: str) -> dict:
    """将 user:pass@host:port/db 格式解析为 psycopg2 连接参数"""
    params = {}
    # 分离 user:password 和 host:port/database
    if "@" in conn_str:
        user_pass, host_db = conn_str.rsplit("@", 1)
        if ":" in user_pass:
            params["user"], params["password"] = user_pass.split(":", 1)
        else:
            params["user"] = user_pass
    else:
        host_db = conn_str

    # 分离 host:port 和 database
    if "/" in host_db:
        host_port, params["dbname"] = host_db.rsplit("/", 1)
    else:
        host_port = host_db

    if ":" in host_port:
        params["host"], port_str = host_port.rsplit(":", 1)
        params["port"] = int(port_str)
    else:
        params["host"] = host_port

    return params

DB_PARAMS = parse_conn_str(DB_CONN_STR)

# ── 服务配置 ───────────────────────────────────────────────
SERVICE_PORT = int(os.environ.get("RAG_SERVICE_PORT", "8100"))
DEFAULT_SIMILARITY_THRESHOLD = 0.5
DEFAULT_LIMIT_COUNT = 3
EMBEDDING_DIM = 1024  # 与 pgvector 配置一致

# ── Embedding / LLM API 配置 ───────────────────────────────────
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
EMBEDDING_MODEL = os.environ.get("LIGHTRAG_EMBEDDING_MODEL", "BAAI/bge-m3")
# 实体抽取用便宜小模型（免费、限流宽松）；质控复判用聪明模型（Node 侧配置）
LLM_MODEL = os.environ.get("LIGHTRAG_LLM_MODEL", "Qwen/Qwen2.5-7B-Instruct")

# ── LightRAG 配置 ──────────────────────────────────────────────
LIGHTRAG_WORKING_DIR = os.environ.get("LIGHTRAG_WORKING_DIR", "./lightrag_data")

# ── 日志配置 ───────────────────────────────────────────────────
LOG_LEVEL = os.environ.get("RAG_LOG_LEVEL", "INFO")
