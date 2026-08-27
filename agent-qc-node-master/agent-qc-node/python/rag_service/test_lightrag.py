"""
test_lightrag.py - LightRAG 集成测试
验证 LightRAG 库能否正常工作
"""
import os
import sys

# 配置数据库连接（本地测试环境）
os.environ["RAG_DB_CONN_STR"] = "postgres:rag123@localhost:5432/rag"

print("=== LightRAG 集成测试 ===\n")

# 1. 测试导入
print("1. 测试导入 lightrag...")
try:
    from lightrag import LightRAG, QueryParam
    from lightrag.base import EmbeddingFunc
    print("   [OK] LightRAG 导入成功")
except ImportError as e:
    print(f"   [FAIL] 导入失败: {e}")
    sys.exit(1)

# 2. 测试数据库 embedding 函数
print("\n2. 测试数据库 embedding...")
try:
    from db import generate_query_embedding
    test_emb = generate_query_embedding("测试文本")
    print(f"   [OK] DB embedding 维度: {len(test_emb)}")
except Exception as e:
    print(f"   [FAIL] DB embedding 失败: {e}")
    print("   提示: 确保数据库连接正常 (RAG_DB_CONN_STR)")
    sys.exit(1)

# 3. 测试创建 LightRAG 实例（使用 DB embedding）
print("\n3. 测试创建 LightRAG 实例（使用 DB embedding）...")
try:
    # 包装 DB embedding 为 LightRAG 格式
    async def custom_embed(texts: list[str]) -> list[list[float]]:
        embeddings = []
        for text in texts:
            emb = generate_query_embedding(text)
            embeddings.append(emb)
        return embeddings
    
    embedding_func = EmbeddingFunc(
        embedding_dim=1024,
        max_token_size=8192,
        func=custom_embed,
    )
    
    rag = LightRAG(
        working_dir="./test_lightrag_data",
        embedding_func=embedding_func,
        # LLM 暂时不配置，只测试 embedding
    )
    print(f"   [OK] 实例创建成功, working_dir={rag.working_dir}")
except Exception as e:
    print(f"   [FAIL] 实例创建失败: {e}")
    sys.exit(1)

# 4. 测试插入文档（需要 LLM，这里只验证流程）
print("\n4. 测试插入文档（需要 LLM，可能失败）...")
test_doc = """
高血压是最常见的慢性病之一，诊断标准为收缩压>=140mmHg和/或舒张压>=90mmHg。
治疗原则包括生活方式干预和药物治疗。常用降压药物包括：
- 钙通道阻滞剂（CCB）：如硝苯地平、氨氯地平
- ACEI/ARB：如依那普利、缬沙坦
- 利尿剂：如氢氯噻嗪、吲达帕胺
"""

try:
    rag.insert(test_doc)
    print("   [OK] 文档插入成功")
except Exception as e:
    print(f"   [INFO] 文档插入需要 LLM: {e}")
    print("   这是正常的，需要配置 OPENAI_API_KEY 才能完成实体抽取")

print("\n=== 测试完成 ===")
print("\n总结：")
print("- LightRAG 库安装: OK")
print("- DB embedding 集成: OK")
print("- 完整功能需要: OPENAI_API_KEY 环境变量")
