require('dotenv').config({ path: '../../.env' })
const debug = require('debug')
const _ = require('lodash/fp')
const askLLM = require('./askLLM') 
const rag = require('./rag')       

const testLog = debug('test:rag')

/**
 * 1. 靶向重写
 */
async function rewriteQuery(defectDesc, ruleDesc) {
    testLog('--- Step 1: 开始靶向重写 ---')
    // 【新增这行打印，看看 askLLM 里面到底有哪些方法】

    const prompt = `你是医疗质控检索助手。请根据以下【质控规则细节】和【病历缺陷】，生成一句用于检索医学指南的精准短句（20-40字），只保留最核心的医学行为或禁忌，不要患者隐私信息。
【质控规则细节】：${ruleDesc}
【病历缺陷】：${defectDesc}
直接输出检索短句，不要解释：`

    const rewrittenQuery = await askLLM.autoRetryAskLLM(prompt, 'star-fast', { enableEncrypt: false })
    testLog(`原缺陷: ${defectDesc}`)
    testLog(`重写后检索词: ${rewrittenQuery}`)
    return rewrittenQuery
}

/**
 * 2 & 3. 召回与精排
 */
async function searchAndRerank(targetQuery, ruleCode, defectDesc) {
    testLog('--- Step 2 & 3: 召回与精排 ---')
    
    const candidates = await rag.ragVerifySearch({
        queryText: targetQuery,
        noteQcCode: ruleCode,
        similarityThreshold: 0.3,
        limitCount: 10
    })

    if (!candidates || candidates.length === 0) {
        testLog('未召回任何候选证据！')
        return []
    }
    testLog(`粗排召回 ${candidates.length} 条候选`)

    const scoredCandidates = await Promise.all(
        candidates.map(async (c) => {
            try {
                const score = await rag.calculateTextSimilarity(defectDesc, c.txt || c.content || '')
                return { ...c, rerank_score: score }
                    } catch (error) {
            testLog(`测试执行失败: ${error.message}`)
            // 【新增这行，打印完整的错误详情】
            console.error('详细错误详情:', error.response?.data || error) 
        }

        })
    )

    const finalEvidences = _.orderBy(['rerank_score'], ['desc'], scoredCandidates).slice(0, 3)
    
    testLog('--- 精排后 Top 3 证据 ---')
    finalEvidences.forEach((e, i) => {
        testLog(`[${i + 1}] Rerank分数: ${e.rerank_score.toFixed(4)} | 原文: ${(e.txt || e.content || '').substring(0, 80)}...`)
    })

    return finalEvidences
}

/**
 * 测试主函数
 */
async function runTest() {
    const testCases = [
        {
            ruleCode: 'A005.002', 
            // 手动把数据库里查到的规则描述填进这里
            ruleDesc: '骨折术后需在24小时内使用低分子肝素抗凝', 
            defectDesc: '患者右股骨干骨折术后，未在24小时内使用低分子肝素抗凝' 
        }
    ]

    for (const testCase of testCases) {
        testLog(`\n========== 开始测试规则: ${testCase.ruleCode} ==========`)
        try {
            const targetQuery = await rewriteQuery(testCase.defectDesc, testCase.ruleDesc)
            const evidences = await searchAndRerank(targetQuery, testCase.ruleCode, testCase.defectDesc)

            if (evidences.length === 0) {
                testLog('⚠️ 警告：一条相关证据都没找到，RAG 应考虑翻盘判无缺陷！')
            } else if (evidences[0].rerank_score < 0.3) {
                testLog('⚠️ 警告：最高分证据的 Rerank 分数依然很低（<0.3），说明证据可能不相关！')
            } else {
                testLog('✅ 成功找到强相关证据，RAG 可据此维持缺陷判定。')
            }

        } catch (error) {
            testLog(`测试执行失败: ${error.message}`)
        }
    }
}

debug.enable('test:rag*')
runTest().then(() => {
    console.log('测试脚本执行完毕')
    process.exit(0)
})
