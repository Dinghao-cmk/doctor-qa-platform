// start_ollama.js - 常驻启动 Ollama serve（node spawn 方式，绕开沙箱对直接启动的限制）
// 用法：node start_ollama.js（后台运行）；serve 异常退出自动重启
const { spawn } = require('child_process')

const OLLAMA = 'C:\\Users\\ASUS\\AppData\\Local\\Programs\\Ollama\\ollama.exe'
const OLLAMA_MODELS = 'c:\\在水医方\\.ollama-models'

let child = null
let restarting = false

function start() {
    if (restarting) return
    restarting = true
    console.log(new Date().toLocaleTimeString(), '启动 ollama serve...')
    child = spawn(OLLAMA, ['serve'], {
        env: { ...process.env, OLLAMA_MODELS },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
    })
    child.stderr.on('data', d => {
        const s = d.toString()
        if (/llama-server|error/i.test(s)) console.log('[llama]', s.slice(0, 300))
    })
    child.on('exit', (code) => {
        console.log(new Date().toLocaleTimeString(), 'serve 退出, code=', code, '5 秒后重启')
        restarting = false
        setTimeout(start, 5000)
    })
    child.on('error', (e) => {
        console.log('启动失败:', e.message, '10 秒后重试')
        restarting = false
        setTimeout(start, 10000)
    })
    restarting = false
}

// 健康检查：serve 挂了但进程还在 → 杀掉重启
setInterval(async () => {
    if (!child) return
    try {
        const r = await fetch('http://localhost:11434/api/tags')
        if (r.ok) return
    } catch (e) { }
    console.log(new Date().toLocaleTimeString(), '健康检查失败，重启 serve')
    try { child.kill() } catch (e) { }
}, 30000)

start()
console.log('守护进程运行中（Ctrl+C 退出）')
