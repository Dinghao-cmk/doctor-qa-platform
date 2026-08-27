const knex = require('../../config/knexfile')
const { extractKnowledge } = require('../../functions/disputeReview')
const { agent_qc_query_table } = require('../../constant')

/**
 * 对已关闭的疑义问题进行知识萃取
 * POST /extractRagKnowledge  { query_id }
 * 自动判断 AI 关闭 / 人工关闭，选择对应 prompt
 * 返回 { isKnowledgeBased, extractedKnowledge }
 */
async function extractRagKnowledge({ query_id }) {
    if (!query_id) throw new Error('缺少参数 query_id')

    // 1. 查 query，校验已关闭
    const query = await knex(agent_qc_query_table)
        .select('name', 'emr_eval_item_id', 'status', 'modify_user_id')
        .where('id', query_id)
        .first()
    if (!query) throw new Error(`未找到 query: ${query_id}`)
    if (query.status !== '关闭') throw new Error(`query 状态非关闭，不允许提取: ${query.status}`)

    // 2. 查规则信息
    const evalItem = await knex('emr_eval_item')
        .select('codev2', 'name', 'description')
        .where('id', query.emr_eval_item_id)
        .first()
    if (!evalItem) throw new Error(`未找到规则: ${query.emr_eval_item_id}`)

    const isAiClosed = query.modify_user_id === -1

    if (isAiClosed) {
        // 3a. AI 关闭 → 从疑义复核记录取 reasoning
        const reviewLog = await knex('emr_eval_log')
            .select('detail')
            .where('query_id', query_id)
            .where('action_type', '疑义复核')
            .orderBy('created_at', 'desc')
            .first()
        if (!reviewLog) throw new Error(`未找到疑义复核记录: ${query_id}`)

        const colonIdx = reviewLog.detail?.indexOf(':') ?? -1
        if (colonIdx < 0) throw new Error('复核记录 detail 格式异常')
        const reasoning = reviewLog.detail.slice(colonIdx + 1).trim()

        return extractKnowledge({
            queryName: query.name,
            ruleName: evalItem.name,
            ruleDescription: evalItem.description,
            reasoning,
        })
    }

    // 3b. 人工关闭 → 从疑义记录取医生疑义内容
    const disputeLog = await knex('emr_eval_log')
        .select('detail')
        .where('query_id', query_id)
        .whereIn('action_type',  ['疑义','申诉'])
        .orderBy('created_at', 'desc')
        .first()
    if (!disputeLog) throw new Error(`未找到疑义记录: ${query_id}`)

    return extractKnowledge({
        queryName: query.name,
        ruleName: evalItem.name,
        ruleDescription: evalItem.description,
        disputeDetail: disputeLog.detail,
        promptName: 'knowledge-extract-from-human-review',
    })
}

module.exports = extractRagKnowledge
