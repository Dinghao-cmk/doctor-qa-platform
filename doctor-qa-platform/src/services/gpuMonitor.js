/**
 * gpuMonitor.js - GPU 指标监控（nvidia-smi 解析）
 * 对比实验期间周期采样 GPU 利用率/显存/温度/功耗，结束后汇总
 * 无 NVIDIA GPU / nvidia-smi 不可用时静默返回 null，不影响主流程
 */
const { execFile } = require('child_process')
const util = require('util')
const execFileP = util.promisify(execFile)

const QUERY_FIELDS = 'name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit'

/** 单次 GPU 快照（首卡；多卡取第一块） */
const snapshotGpu = async () => {
    try {
        const { stdout } = await execFileP('nvidia-smi', [`--query-gpu=${QUERY_FIELDS}`, '--format=csv,noheader'], { timeout: 5000 })
        const line = stdout.trim().split('\n')[0]
        if (!line) return null
        const [name, util, memUsed, memTotal, temp, power, powerLimit] = line.split(',').map(s => s.trim())
        return {
            name,
            util: parseFloat(util) || 0,
            memUsedMiB: parseInt(memUsed) || 0,
            memTotalMiB: parseInt(memTotal) || 0,
            tempC: parseInt(temp) || 0,
            powerW: parseFloat(power) || 0,
            powerLimitW: parseFloat(powerLimit) || 0,
        }
    } catch {
        return null // nvidia-smi 不可用/非 NVIDIA 环境
    }
}

/**
 * 启动周期采样
 * @param {number} intervalMs - 采样间隔（默认 2s）
 * @param {number} maxSamples - 最多采样数（默认 60，防长请求无限采样）
 * @returns {Promise<{stop: Function}>} stop() 返回汇总或 null
 */
const startSampling = async (intervalMs = 2000, maxSamples = 60) => {
    const samples = []
    let stopped = false
    const timer = setInterval(async () => {
        if (stopped) return
        const g = await snapshotGpu()
        if (g) samples.push(g)
    }, intervalMs)
    // 立即采一帧基线
    const base = await snapshotGpu()
    if (base) samples.push(base)

    return {
        stop: async () => {
            if (stopped) return null
            stopped = true
            clearInterval(timer)
            const end = await snapshotGpu()
            if (end) samples.push(end)
            if (samples.length === 0) return null
            return {
                name: samples[0].name,
                utilAvg: Math.round(samples.reduce((s, x) => s + x.util, 0) / samples.length),
                utilPeak: Math.max(...samples.map(s => s.util)),
                memUsedMiB: end ? end.memUsedMiB : samples[samples.length - 1].memUsedMiB,
                memTotalMiB: samples[0].memTotalMiB,
                memUtilPct: Math.round((end ? end.memUsedMiB : samples[samples.length - 1].memUsedMiB) / samples[0].memTotalMiB * 100),
                tempMin: Math.min(...samples.map(s => s.tempC)),
                tempMax: Math.max(...samples.map(s => s.tempC)),
                powerW: end ? end.powerW : samples[samples.length - 1].powerW,
                powerLimitW: samples[0].powerLimitW,
                samples: samples.length,
            }
        },
    }
}

module.exports = { startSampling, snapshotGpu }
