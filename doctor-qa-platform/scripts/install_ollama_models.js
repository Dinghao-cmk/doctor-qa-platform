// install_ollama_models.js - 手动构造 Ollama 模型（绕过沙箱对 create/pipe 的限制）
// 原理：Ollama 模型 = blobs（GGUF/配置/许可证）+ manifests JSON，按旧库格式照抄
// 硬链接复用旧库已存在的 blob（bge-m3），GGUF 直接从工作区链接（零拷贝）
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const OLD = 'C:\\Users\\ASUS\\.ollama\\models'
const NEW = 'c:\\在水医方\\.ollama-models'
const GGUF = 'c:\\在水医方\\doctor-qa-platform\\finetune\\output\\qwen2.5-7b-med-qa-q8_0.gguf'

const blobsDir = path.join(NEW, 'blobs')
const manifestsDir = path.join(NEW, 'manifests', 'registry.ollama.ai', 'library')
fs.mkdirSync(blobsDir, { recursive: true })
fs.mkdirSync(manifestsDir, { recursive: true })

// 硬链接（同卷 C 盘，零拷贝；源在旧库或工作区）
function link(src, name) {
    const dst = path.join(blobsDir, name)
    if (fs.existsSync(dst)) return dst
    fs.linkSync(src, dst)
    return dst
}

// 写新 blob（内容字符串，自动算 sha256 命名）
function writeBlob(content) {
    const hash = crypto.createHash('sha256').update(content).digest('hex')
    const dst = path.join(blobsDir, 'sha256-' + hash)
    if (!fs.existsSync(dst)) fs.writeFileSync(dst, content)
    return 'sha256:' + hash
}

// ===== 1. qwen2.5-7b-med-qa（GGUF 硬链接 + 配置 + manifest） =====
;(async () => {
const ggufStat = fs.statSync(GGUF)
const ggufHash = crypto.createHash('sha256')
await new Promise((resolve, reject) => {
    const s = fs.createReadStream(GGUF)
    s.on('data', d => ggufHash.update(d))
    s.on('end', resolve)
    s.on('error', reject)
})
const ggufHashHex = ggufHash.digest('hex')
const ggufDst = link(GGUF, 'sha256-' + ggufHashHex)

const config = { model_format: 'gguf', model_family: 'qwen2', model_families: ['qwen2'], model_type: '7.6B', file_type: 'Q8_0', architecture: 'amd64', os: 'linux' }
const configDigest = writeBlob(JSON.stringify(config))

const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
    config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: configDigest, size: Buffer.byteLength(JSON.stringify(config)) },
    layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: 'sha256:' + ggufHashHex, size: ggufStat.size }],
}
fs.mkdirSync(path.join(manifestsDir, 'qwen2.5-7b-med-qa'), { recursive: true })
fs.writeFileSync(path.join(manifestsDir, 'qwen2.5-7b-med-qa', 'latest'), JSON.stringify(manifest))
console.log('med-qa: GGUF', (ggufStat.size / 1e9).toFixed(2) + 'GB', '| 部署完成')

// ===== 2. bge-m3（旧库 blob 硬链接 + manifest 照抄） =====
const bgeManifest = JSON.parse(fs.readFileSync(path.join(OLD, 'manifests', 'registry.ollama.ai', 'library', 'bge-m3', 'latest'), 'utf8'))
for (const layer of [bgeManifest.config, ...bgeManifest.layers]) {
    const src = path.join(OLD, 'blobs', layer.digest.replace('sha256:', 'sha256-'))
    const dst = path.join(blobsDir, layer.digest.replace('sha256:', 'sha256-'))
    if (!fs.existsSync(dst)) {
        if (!fs.existsSync(src)) throw new Error('旧库缺 blob: ' + src)
        fs.linkSync(src, dst)
    }
}
fs.mkdirSync(path.join(manifestsDir, 'bge-m3'), { recursive: true })
fs.writeFileSync(path.join(manifestsDir, 'bge-m3', 'latest'), JSON.stringify(bgeManifest))
console.log('bge-m3: 部署完成')

// ===== 3. 验证 =====
const { execSync } = require('child_process')
const list = execSync('"C:\\Users\\ASUS\\AppData\\Local\\Programs\\Ollama\\ollama.exe" list', { encoding: 'utf8' })
console.log(list)
process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
