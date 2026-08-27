/**
 * config.js - 集中管理环境变量与配置
 */
require('dotenv').config()

const config = {
    // 服务端口
    port: parseInt(process.env.PORT || '3009', 10),

    // RAG 数据库连接（只读）
    ragDbConnStr: process.env.RAG_DB_CONN_STR
        ? 'postgresql://' + process.env.RAG_DB_CONN_STR
        : 'postgresql://postgres:postgres@localhost:5433/rag',

    // LLM 配置（用 DeepSeek 生成回答）
    llm: {
        apiUrl: process.env.LLM_API_URL || 'https://api.deepseek.com/v1/chat/completions',
        apiKey: process.env.LLM_API_KEY || '',
        model: process.env.LLM_MODEL || 'deepseek-v4-flash', // 快模型：日常问答/重排序/关键词提炼
        strongModel: process.env.LLM_STRONG_MODEL || 'deepseek-reasoner', // 强模型：复杂问题/多源综合/长对话追问
        // 知识库未命中时是否用 LLM 通用知识兜底回答（默认开启，回答带免责标注）
        fallback: (process.env.LLM_FALLBACK || 'true') !== 'false',
    },

    // 重排序参数
    rerank: {
        // 保留的最低相关度等级：2=直接相关 1=弱相关 0=无关（默认 1）
        minLevel: parseInt(process.env.RERANK_MIN_LEVEL || '1', 10),
    },

    // 搜索参数
    search: {
        defaultLimit: parseInt(process.env.DEFAULT_LIMIT || '5', 10),
        // RRF 融合排序参数（多通道检索结果融合，替代硬编码优先级）
        // 权重可在 qa_settings 表配置（key=search_fusion）覆盖，动态生效
        fusion: {
            // RRF 常数 k：分数 = Σ w_i / (k + rank_i)，k 越大越平滑、越偏向召回广度
            rrfK: parseFloat(process.env.SEARCH_RRF_K || '60'),
            // 各检索通道权重（自学习脚本可基于黄金题库自动寻优后写回配置）
            weights: {
                vector: parseFloat(process.env.SEARCH_FUSION_VECTOR_W || '1'),
                keyword: parseFloat(process.env.SEARCH_FUSION_KEYWORD_W || '1'),
                title: parseFloat(process.env.SEARCH_FUSION_TITLE_W || '1'),
                path: parseFloat(process.env.SEARCH_FUSION_PATH_W || '0.8'),
            },
            // 向量检索无命中时的降级阈值（两级自适应回退的第二级）
            vectorFallback: parseFloat(process.env.SEARCH_VECTOR_FALLBACK || '0.4'),
        },
    },

    // 上传限制
    upload: {
        // 单文件大小上限（MB）：几千页大书（文字版 PDF/TXT/MD）通常几十 MB；
        // 扫描版 PDF 无文字层不支持（parseFile 会明确报错）；500MB 覆盖大体积医学书/报告合集
        maxMb: parseInt(process.env.MAX_UPLOAD_MB || '500', 10),
    },
}

module.exports = config
