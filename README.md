<<<<<<< HEAD
# doctor-qa-platform
=======
# 医学知识问答平台（Medicine QA Platform）

面向临床医生的医学知识问答系统：**RAG 检索增强问答 + 多模型对比实验 + 本地微调模型**。
基于权威医学书籍/指南/质控规则库构建知识库，支持多轮追问、引用溯源、联网兜底与反馈闭环。

---

## ✨ 核心能力

### 1. 混合检索（RAG）
- **三路并行检索**：向量（本地 bge-m3，1024 维）+ 关键词（jieba 分词 + GIN 索引）+ 标题检索
- **RRF 融合排序**：权重可配置，多路结果融合去重
- **LLM 重排**：三级相关度判定（保留/弱相关/删除），关键词兜底恢复
- **章节路径兜底**：候选不足时按"书→章→节→段落"结构补全

### 2. 多模型体系
| 模型 | 类型 | 说明 |
|---|---|---|
| deepseek-v4-flash | 云端 | 默认快模型，智能路由 |
| deepseek-v4-pro | 云端 | 强模型（复杂/多源综合问题） |
| qwen2.5-7b-med-qa | 本地微调 | 问答微调版（规则问答 + 段落问答 + 诚实约束） |
| qwen2.5-7b-med-r4-v5 | 本地微调 | 质控判定版（缺陷样本判定训练） |

- **智能路由**：按问题复杂度/命中书籍数/追问轮数自动选快/强模型
- **提问前自选模型**：每次提问可手动指定模型（含本地微调版）
- **本地模型离线可用**：Ollama 部署，断网也能问答

### 3. 对比实验体系（老板看板）
回答下方三组并排实验，同一问题、同一链路，量化对比：

- **🔬 RAG 机制对比**：完整 RAG / 无 RAG / 差 RAG → 验证检索价值
- **🤖 模型对比**：同一链路不同模型（flash / pro / 本地微调）→ 验证模型差异
- **📈 版本进步对比**：本地微调各版本 vs 云端基线 → 验证微调迭代进步

每张实验卡附 **⚙ 技术参数面板**：模型 / 端点 / 检索方式 / 候选数 / 耗时 / 回答字数 / Token 消耗 / 提示词版本 / 引用统计 / **GPU 指标**（利用率、显存、温度、功耗——实验期间自动采样）。

### 4. 知识库与闭环
- 权威书籍/指南 PDF 上传解析（自动分章分节，500MB 以内）
- 弱命中自动联网增强（权威域名优先），未收录问题记入待补清单
- 引用一致性校验（[参考N] 合法性 + 非法编号自动修正）
- 用户反馈（badcase 样本池）驱动检索学习闭环

---

## 📁 目录结构

```
├── doctor-qa-platform/          # 平台主应用（Node.js + Express + PostgreSQL/pgvector）
│   ├── src/
│   │   ├── services/            # 检索/重排/路由/LLM/GPU监控/embedding
│   │   ├── routes/              # 问答 API（含对比实验、流式 SSE）
│   │   └── server.js
│   ├── public/index.html        # 前端（问答 + 对比实验看板）
│   ├── finetune/                # 本地微调（训练脚本、数据生成、QA 数据集）
│   └── scripts/                 # 数据生成/模型安装/检索调参
├── agent-qc-node-master/        # 质控 agent 的 RAG 优化（本人代码）
│   └── agent-qc-node/python/rag_service/  # LightRAG/GraphRAG/PageIndex 检索服务
│   └── agent-qc-node/node/config/rag*.js  # RAG 检索模块（重排/查询改写/页面索引）
│   └── agent-qc-node/prompts/rag-2507*.md # RAG 复判提示词
│   └── agent-qc-node/scripts/ingest_book.js 书籍入库 + GPU_SERVER/vllm 部署
```

---

## 🚀 快速开始

### 环境要求
- Node.js 18+、PostgreSQL 14+（pgvector 扩展）
- NVIDIA GPU（推荐，本地微调模型推理）/ 或纯云端模式
- Ollama（本地模型，可选）

### 启动

```bash
cd doctor-qa-platform
npm install
cp .env.example .env        # 配置 LLM API / 数据库 / 检索参数
node src/server.js          # 启动（默认 3012 端口）
```

浏览器打开 `http://localhost:3012`。

### 本地模型（可选）

```bash
# 首次：安装 Ollama 模型库（GGUF + manifest）
node scripts/install_ollama_models.js

# 常驻守护（自动健康检查 + 重启）
node start_ollama.js
```

平台设置中配置 `llm_local_api_url` / `llm_local_model` 即可启用本地微调模型对比。

---

## 🎓 本地微调（finetune）

- 基座：`Qwen2.5-7B-Instruct`（LoRA r16 + 4bit QLoRA）
- 数据：质控规则问答（1680）+ 核查卡判定样本 + 诚实负样本（50）+ 深度问答（段落生成）
- 产出：`qa_dataset_v2.jsonl` → 训练 → 合并 → GGUF q8_0 → Ollama 部署

```bash
cd doctor-qa-platform/finetune
python train_llm.py --r 16          # 训练（~40-60 分钟）
python merge_bf16_shards.py         # 合并权重
python convert_hf_to_gguf.py ...    # 转 GGUF
```

模型权重不入库（体积 >30GB），训练脚本与数据生成代码完整保留。

---

## 📊 技术参数

- 检索：向量 1024 维（bge-m3）、余弦相似度、RRF 融合（k=60）、阈值可配置（0.5/降级 0.4）
- 重排：LLM 三级判定，minLevel=1，候选上限 10
- 回答：流式 SSE、多轮历史压缩、prompt 版本化（可追溯）
- 监控：结构化日志（debug 命名空间）、GPU 采样（2s 间隔）、token 消耗采集

---

## 🔒 安全

- 敏感配置（API Key）仅存 `.env`（已 gitignore）
- 模型权重/大文件不纳入仓库
- 本地模型带诚实约束 prompt：知识库外/截止日期后内容明确"不确定"，不编造
>>>>>>> 6ded55c (医学知识问答平台：RAG检索 + 对比实验体系 + 本地微调模型接入)
