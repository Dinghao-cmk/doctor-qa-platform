/**
 * citation.js - 引用一致性校验
 *
 * 规则层：解析回答中的 [参考N] 标注，检查编号是否在来源范围内，
 *         非法编号（不存在于参考资料）从回答中移除，避免幻觉引用
 * 统计层：计算引用覆盖率（回答实际引用的来源数 / 来源总数），
 *         覆盖率低说明模型漏引，可在 meta 中提示
 */
const REF_RE = /\[参考(\d+)\]/g

/**
 * 提取回答中的所有引用编号
 * @param {string} answer
 * @returns {number[]}
 */
const extractRefs = (answer) => {
    if (!answer) return []
    const refs = []
    let m
    REF_RE.lastIndex = 0
    while ((m = REF_RE.exec(answer)) !== null) {
        refs.push(parseInt(m[1], 10))
    }
    return refs
}

/**
 * 校验回答的引用一致性
 * @param {string} answer - LLM 生成的回答
 * @param {number} sourceCount - 参考资料条数
 * @returns {Object}
 * {
 *   refs: number[],        // 全部引用编号
 *   valid: number[],       // 合法编号
 *   invalid: number[],     // 非法编号（幻觉引用）
 *   invalidRatio: number,  // 非法占比 0~1
 *   coverage: number,      // 引用覆盖率 0~1（被引用来源数/来源总数）
 *   answer: string,        // 清理非法标注后的回答
 *   fixed: boolean,        // 是否发生了清理
 * }
 */
const validateCitations = (answer, sourceCount) => {
    const refs = extractRefs(answer)
    const valid = refs.filter(n => n >= 1 && n <= sourceCount)
    const invalid = refs.filter(n => n < 1 || n > sourceCount)
    const invalidSet = new Set(invalid)

    // 从回答中移除非法标注（保留合法标注）
    let fixedAnswer = answer
    if (invalid.length > 0) {
        fixedAnswer = answer.replace(REF_RE, (token, numStr) => {
            const n = parseInt(numStr, 10)
            return invalidSet.has(n) ? '' : token
        })
        // 清理移除后可能留下的多余空格/标点粘连
        fixedAnswer = fixedAnswer.replace(/[，。；、]\s*(?=[，。；、])/g, '$1').replace(/\(\s*\)/g, '')
    }

    const covered = new Set(valid)
    return {
        refs,
        valid,
        invalid,
        invalidRatio: refs.length > 0 ? invalid.length / refs.length : 0,
        coverage: sourceCount > 0 ? covered.size / sourceCount : 0,
        answer: fixedAnswer,
        fixed: invalid.length > 0,
    }
}

/**
 * 是否应触发重新生成（引用错误严重时重试一次）
 * 触发条件：存在非法引用，且 非法占比 ≥50% 或 非法数 ≥2
 * @param {Object} v - validateCitations 的返回值
 * @returns {boolean}
 */
const shouldRetry = (v) => {
    if (!v || v.invalid.length === 0) return false
    return v.invalidRatio >= 0.5 || v.invalid.length >= 2
}

module.exports = { extractRefs, validateCitations, shouldRetry }
