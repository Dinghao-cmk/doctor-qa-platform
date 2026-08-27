/**
 * RAG 服务配置
 */
const agent = require('superagent') // HTTP请求库
const { RAG_SERVER_ROOT } = require('../constant')

const RAG_SIMILARITY_URL = RAG_SERVER_ROOT + '/text_similarity'
const RAG_SEARCH_URL = RAG_SERVER_ROOT + '/rag_search'
const RAG_VERIFY_SEARCH_URL = RAG_SERVER_ROOT + '/rag_verify_search'
const RAG_VERIFY_INSERT_URL = RAG_SERVER_ROOT.replace(/\/rpc$/, '') + '/rag_verify'

/**
 * RAG搜索 - 根据查询文本搜索相似内容
 * @param {Object} options 搜索参数
 * @param {string} options.queryText 查询文本
 * @param {number} [options.similarityThreshold=0.6] 相似度阈值
 * @param {number} [options.limitCount=3] 限制返回数量
 * @returns {Promise<any>} 搜索结果
 */
async function ragSearch({ queryText, similarityThreshold = 0.6, limitCount = 3 }) {
    try {
        const response = await agent
            .post(RAG_SEARCH_URL)
            .send({
                query_text: queryText,
                similarity_threshold: similarityThreshold,
                limit_count: limitCount,
            })
            .set('Content-Type', 'application/json')
        return response.body
    } catch (error) {
        console.error('RAG搜索失败:', error.message)

        // 新增：尝试打印服务器返回的具体错误信息（如果有）
        if (error.response) {
            console.error('服务器返回的原始响应（状态码：', error.response.status, '）：')
            console.error(
                'Body:',
                typeof error.response.body === 'object'
                    ? JSON.stringify(error.response.body, null, 2)
                    : error.response.text || error.response.body
            )
        }

        throw new Error(`RAG搜索失败: ${error.message}`)
    }
}

/**
 * RAG验证搜索 - 根据查询文本和质控代码搜索相似内容
 * @param {Object} options 搜索参数
 * @param {string} options.queryText 查询文本
 * @param {string} options.noteQcCode 质控代码
 * @param {number} [options.similarityThreshold=0.6] 相似度阈值
 * @param {number} [options.limitCount=3] 限制返回数量
 * @returns {Promise<any>} 搜索结果
 */
async function ragVerifySearch({ queryText, noteQcCode, similarityThreshold = 0.6, limitCount = 3 }) {
    try {
        console.log('🔍 [ragVerifySearch] 开始请求，URL:', RAG_VERIFY_SEARCH_URL)
        console.log('🔍 [ragVerifySearch] 请求参数:', {
            query_text: queryText?.substring(0, 100) + '...',
            note_qc_code: noteQcCode,
            similarity_threshold: similarityThreshold,
            limit_count: limitCount,
        })
        
        const response = await agent
            .post(RAG_VERIFY_SEARCH_URL)
            .send({
                query_text: queryText,
                note_qc_code: noteQcCode,
                similarity_threshold: similarityThreshold,
                limit_count: limitCount,
            })
            .set('Content-Type', 'application/json')
            
        console.log('✅ [ragVerifySearch] 请求成功，响应状态:', response.status)
        console.log('✅ [ragVerifySearch] 响应体类型:', Array.isArray(response.body) ? 'array' : typeof response.body)
        console.log('✅ [ragVerifySearch] 响应体:', JSON.stringify(response.body, null, 2))
        
        return response.body
        } catch (error) {
        console.error('❌ [ragVerifySearch] RAG验证搜索失败:', error.message)

        // 新增：打印服务端返回的原始错误（如果有）
        if (error.response) {
            console.error('❌ [ragVerifySearch] 服务端原始响应（状态码：', error.response.status, '）：')
            console.error(
                'Body:',
                typeof error.response.body === 'object'
                    ? JSON.stringify(error.response.body, null, 2)
                    : error.response.text || error.response.body
            )
        }

        console.error('❌ [ragVerifySearch] 错误详情:', error.stack || error)
        throw new Error(`RAG验证搜索失败: ${error.message}`)
    }

}

/**
 * 计算两个文本的相似度
 * @param {string} text1 第一个文本
 * @param {string} text2 第二个文本
 * @returns {Promise<number>} 相似度分数（0-1之间的浮点数，1表示完全相同，0表示完全不同）
 */
async function calculateTextSimilarity(text1, text2) {
    try {
        const response = await agent
            .post(RAG_SIMILARITY_URL)
            .send({
                text1,
                text2,
            })
            .set('Content-Type', 'application/json')
        return response.body
    } catch (error) {
        console.error('计算文本相似度失败:', error.message)
        return 0
    }
}

/**
 * 插入知识到 rag_verify
 * @param {Object} options 插入参数
 * @param {string} options.noteQcCode 质控代码
 * @param {string} options.txt 知识文本
 * @param {string} options.source 来源：manual | ai
 * @param {number} options.userId 缺陷ID，-1为ai
 * @param {number} options.queryId 缺陷ID
 * @param {boolean} [options.enabled] 是否启用（参与检索）。默认启用，后续由人工审核决定是否弃用
 * @returns {Promise<any>} 插入结果
 */
async function ragVerifyInsert({ noteQcCode, txt, source, userId, queryId, enabled }) {
    try {
        const response = await agent
            .post(RAG_VERIFY_INSERT_URL)
            .send({
                note_qc_code: noteQcCode,
                txt,
                source,
                user_id: userId ?? -1,
                query_id: queryId ?? null,
                // 未显式指定时交由数据库默认值（默认 true 启用），人工审核后可置 false 弃用
                ...(enabled === undefined ? {} : { enabled }),
            })
            .set('Content-Type', 'application/json')
        return response.body
    } catch (error) {
        console.error('RAG知识插入失败:', error.message)
        throw new Error(`RAG知识插入失败: ${error.message}`)
    }
}

module.exports = {
    ragSearch,
    ragVerifySearch,
    ragVerifyInsert,
    calculateTextSimilarity,
}

async function test() {
    calculateTextSimilarity('天气一般', '天气凑合').then(console.log)
    ragSearch({ queryText: '肌力4级表述问题' }).then(console.log)
    ragVerifySearch({ queryText: '肌力表述', noteQcCode: 'J001.028', similarityThreshold: 0.5 }).then(console.log)
}

async function minimalTest() {
    try {
        console.log('【极简测试】只用 queryText，其它都用默认值')
        const res = await ragSearch({
            queryText: '肌力4级表述问题'  // 不带 '...'，中文纯文本
        })
        console.log('极简测试成功，返回：', res)
    } catch (e) {
        console.error('极简测试失败：', e.message)
    }
}

if (require.main === module) {
    minimalTest().catch(console.error)
}

if (require.main === module) test()
  