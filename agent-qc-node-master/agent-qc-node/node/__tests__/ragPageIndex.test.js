// @ts-nocheck
jest.mock('../config/ragKnexfile', () => jest.fn())
jest.mock('../config/askLLM', () => jest.fn())

const mockPost = jest.fn()
jest.mock('superagent', () => ({ post: mockPost }))

const ragKnex = require('../config/ragKnexfile')
const ragPageIndex = require('../config/ragPageIndex')
const {
    getPageRoute,
    invalidateRouteCache,
    getRouteCacheSize,
    pageIndexSearch,
    keywordSearch,
    expandDrugSynonyms,
    llmRouteReasoning,
} = ragPageIndex

const askLLM = require('../config/askLLM')

const ragKnexRawMock = jest.fn()
ragKnex.raw = ragKnexRawMock

describe('ragPageIndex.getPageRoute', () => {
    const createQueryBuilder = ({ rows = [], error = null } = {}) => {
        const orderBy = jest.fn().mockImplementation(() => {
            if (error) {
                return Promise.reject(error)
            }
            return Promise.resolve(rows)
        })

        return {
            select: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            andWhere: jest.fn().mockReturnThis(),
            orderBy,
        }
    }

    beforeEach(() => {
        ragKnex.mockReset()
        invalidateRouteCache()
    })

    it('returns null when noteQcCode is empty', async () => {
        await expect(getPageRoute('')).resolves.toBeNull()
        expect(ragKnex).not.toHaveBeenCalled()
    })

    it('fetches route from database and caches result', async () => {
        const rows = [
            { doc_id: 1, passage_ids: [10, 11] },
            { doc_id: 2, passage_ids: [12] },
        ]
        const queryBuilder = createQueryBuilder({ rows })
        ragKnex.mockImplementation(() => queryBuilder)

        const result = await getPageRoute('QC001')
        expect(result).toEqual({ docIds: [1, 2], passageIds: [10, 11, 12] })
        expect(getRouteCacheSize()).toBe(1)

        ragKnex.mockClear()
        const cachedResult = await getPageRoute('QC001')
        expect(cachedResult).toEqual(result)
        expect(ragKnex).not.toHaveBeenCalled()
    })

    it('returns null and caches when no rows found', async () => {
        const queryBuilder = createQueryBuilder({ rows: [] })
        ragKnex.mockImplementation(() => queryBuilder)

        const result = await getPageRoute('QC002')
        expect(result).toBeNull()
        expect(getRouteCacheSize()).toBe(1)

        ragKnex.mockClear()
        const cachedNull = await getPageRoute('QC002')
        expect(cachedNull).toBeNull()
        expect(ragKnex).not.toHaveBeenCalled()
    })

    it('handles database schema errors gracefully', async () => {
        const error = new Error('relation "data.rag_rule_doc_map" does not exist')
        const queryBuilder = createQueryBuilder({ error })
        ragKnex.mockImplementation(() => queryBuilder)

        const result = await getPageRoute('QC003')
        expect(result).toBeNull()
        expect(getRouteCacheSize()).toBe(1)

        ragKnex.mockClear()
        await getPageRoute('QC003')
        expect(ragKnex).not.toHaveBeenCalled()
    })
})

describe('ragPageIndex.pageIndexSearch', () => {
    beforeEach(() => {
        mockPost.mockReset()
    })

    it('posts payload and returns response body on success', async () => {
        const responseBody = [{ txt: 'res' }]
        const setMock = jest.fn().mockResolvedValue({ body: responseBody })
        const sendMock = jest.fn().mockReturnValue({ set: setMock })
        mockPost.mockReturnValue({ send: sendMock })

        const result = await pageIndexSearch({
            queryText: '术后发热',
            noteQcCode: 'QC100',
            docIds: [1, 2],
            passageIds: [10],
            similarityThreshold: 0.7,
            limitCount: 5,
        })

        expect(mockPost).toHaveBeenCalledWith(expect.stringContaining('/rag_pageindex_search'))
        expect(sendMock).toHaveBeenCalledWith({
            query_text: '术后发热',
            note_qc_code: 'QC100',
            doc_ids: [1, 2],
            passage_ids: [10],
            similarity_threshold: 0.7,
            limit_count: 5,
        })
        expect(setMock).toHaveBeenCalledWith('Content-Type', 'application/json')
        expect(result).toEqual(responseBody)
    })

    it('returns null when remote service rejects', async () => {
        const setMock = jest.fn().mockRejectedValue(new Error('timeout'))
        const sendMock = jest.fn().mockReturnValue({ set: setMock })
        mockPost.mockReturnValue({ send: sendMock })

        const res = await pageIndexSearch({
            queryText: '术后发热',
            noteQcCode: 'QC101',
            docIds: [3],
        })

        expect(mockPost).toHaveBeenCalled()
        expect(res).toBeNull()
    })
})

class MockKnexBuilder {
    constructor(results) {
        this.results = results
        this.calls = {
            select: /** @type {any[][]} */ ([]),
            andWhere: /** @type {any[][]} */ ([]),
            limit: /** @type {any[][]} */ ([]),
            whereRaw: /** @type {Array<any[]>} */ ([]),
            whereIn: /** @type {any[][]} */ ([]),
            selectRaw: /** @type {any[][]} */ ([]),
        }
    }

    select(...args) {
        this.calls.select.push(args)
        return this
    }

    andWhere(...args) {
        this.calls.andWhere.push(args)
        return this
    }

    limit(...args) {
        this.calls.limit.push(args)
        return this
    }

    whereRaw(...args) {
        this.calls.whereRaw.push(args)
        return this
    }

    whereIn(...args) {
        this.calls.whereIn.push(args)
        return this
    }

    orderBy() {
        return this
    }

    selectRaw(...args) {
        this.calls.selectRaw.push(args)
        return this
    }

    then(onFulfilled) {
        return Promise.resolve(this.results).then(onFulfilled)
    }

    catch(onRejected) {
        return Promise.resolve(this.results).catch(onRejected)
    }
}

describe('ragPageIndex.keywordSearch', () => {
    beforeEach(() => {
        ragKnex.mockReset()
        jest.restoreAllMocks()
    })

    it('returns null without calling database when query text is empty', async () => {
        const result = await keywordSearch('', [1])
        expect(result).toBeNull()
        expect(ragKnex).not.toHaveBeenCalled()
    })

    it('uses strict keyword search results when available', async () => {
        const builder = new MockKnexBuilder([
            { id: 1, doc_id: 11, section_path: 'A', content: 'content' },
        ])
        ragKnex.mockReturnValue(builder)

        jest
            .spyOn(ragPageIndex, 'expandDrugSynonyms')
            .mockResolvedValue({ keywords: ['术后', '发热'], expansions: {} })

        const results = await keywordSearch('患者术后发热', [11], 2)

        /** @type {(string | undefined)[]} */
        const likeParams = builder.calls.whereRaw.map((call) => {
            const params = call[1]
            return Array.isArray(params) ? params[0] : undefined
        })
        expect(likeParams.length).toBeGreaterThanOrEqual(3)
        expect(likeParams).toEqual(
            expect.arrayContaining(['%患者术后%', '%者术后发%', '%术后发热%'])
        )
        expect(results).toEqual([
            { id: 1, doc_id: 11, section_path: 'A', content: 'content' },
        ])
    })
})

describe('ragPageIndex.expandDrugSynonyms', () => {
    beforeEach(() => {
        ragKnex.mockReset()
    })

    it('expands matched drug synonyms and caches result', async () => {
        const rows = [
            { canonical_name: '头孢曲松', synonyms: ['罗氏芬', 'ceftriaxone'] },
        ]

        ragKnex.mockImplementation((/** @type {string} */ table) => {
            if (table !== 'rag_drug_synonym') {
                throw new Error(`unexpected table ${table}`)
            }
            return {
                select: jest.fn().mockReturnThis(),
                where: jest.fn().mockResolvedValue(rows),
            }
        })

        const input = ['罗氏芬']
        const result = await expandDrugSynonyms(input)

        expect(result.keywords).toEqual(['罗氏芬', 'ceftriaxone'])
        expect(result.expansions).toEqual({ 罗氏芬: ['ceftriaxone'] })

        ragKnex.mockImplementation(() => {
            throw new Error('should not be called again due to cache')
        })

        const cached = await expandDrugSynonyms(['罗氏芬'])
        expect(cached.keywords).toEqual(['罗氏芬', 'ceftriaxone'])
    })
})