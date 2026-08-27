# 对比实验批处理：A基线 / B检索增强 / C强模型 / D组合
# 每组之间清缓存，避免 threshold/limit 未入 cacheKey 导致组间缓存污染
$ErrorActionPreference = 'Continue'
# 用 $PSScriptRoot 定位项目根目录（避免脚本内中文路径被 GBK 解析乱码）
Set-Location (Join-Path $PSScriptRoot '..\..')
$log = "$PSScriptRoot\results\experiment_run.log"

function Clear-Cache {
    node -e "require('http').get('http://localhost:3009/api/cache/clear',r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>{console.log('cache:',b);process.exit(0)})}).on('error',e=>{console.log('cache clear err:',e.message);process.exit(0)})"
}

"==== 实验开始 $(Get-Date -Format 'HH:mm:ss') ====" | Out-File -FilePath $log -Encoding utf8

"==== [A] 基线 (thr=0.5, lim=5, 路由模型) ====" | Out-File -Append -FilePath $log -Encoding utf8
Clear-Cache | Out-File -Append -FilePath $log -Encoding utf8
node scripts/eval/run_eval.js --judge 2>&1 | Out-File -Append -FilePath $log -Encoding utf8

"==== [B] 检索增强 (thr=0.45, lim=10, 路由模型) ====" | Out-File -Append -FilePath $log -Encoding utf8
Clear-Cache | Out-File -Append -FilePath $log -Encoding utf8
node scripts/eval/run_eval.js --judge --threshold 0.45 --limit 10 2>&1 | Out-File -Append -FilePath $log -Encoding utf8

"==== [C] 强模型 (thr=0.5, lim=5, 强制strong) ====" | Out-File -Append -FilePath $log -Encoding utf8
Clear-Cache | Out-File -Append -FilePath $log -Encoding utf8
node scripts/eval/run_eval.js --judge --mode strong 2>&1 | Out-File -Append -FilePath $log -Encoding utf8

"==== [D] 组合 (thr=0.45, lim=10, 强制strong) ====" | Out-File -Append -FilePath $log -Encoding utf8
Clear-Cache | Out-File -Append -FilePath $log -Encoding utf8
node scripts/eval/run_eval.js --judge --mode strong --threshold 0.45 --limit 10 2>&1 | Out-File -Append -FilePath $log -Encoding utf8

"==== 实验结束 $(Get-Date -Format 'HH:mm:ss') ====" | Out-File -Append -FilePath $log -Encoding utf8
