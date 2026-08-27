# GPU 服务器 vLLM PM2 部署命令（jz2y · host llm）

> 江中二院（文档名沿用 jz2y；运行时医院编码为 `jzefy`，见 AGENTS.md §2）GPU 服务器部署。  
> 机器：host `llm`，坏卡卸载后 **7 张 RTX 4090 D（约 48G/卡），可用卡 0-6**，Python 环境：`/opt/conda/envs/vllm`。  
> 统一写法：`pm2 start bash --name <进程名> -- -c "CUDA_VISIBLE_DEVICES=<卡号> <python> -m vllm.entrypoints.openai.api_server ..."`  
> 约定：**pm2 name 的 `cN` 后缀 = 该实例绑定的 GPU 卡号**（如 `c3` → `CUDA_VISIBLE_DEVICES=3`）。

## 参数对齐说明

- **`max-model-len` / `max_num_seqs` 对齐 `pm2-vllm-deploy.md`（gpu04 生产值）**：star-slow / moon-slow = 30720，star-fast = 20480，embedding = 512；`max_num_seqs` 统一 30（embedding 3）。
- **`gpu-memory-utilization` 按显存折算**：新卡 48G ≈ 旧卡 24G 的 2 倍，故在旧文档基础上**折半**，保持相同的「绝对显存预算」（旧机用该绝对显存已验证可容纳 30720 上下文）。
  - star-slow 0.4 → **0.2**（≈9.6G）；moon-slow 0.95 → **0.48**（≈23G）；star-fast 0.5 → **0.25**（≈12G）；embedding 0.2 → **0.1**（≈4.8G）。
- **可用卡 0-6**：坏卡（原 GPU0 ERR!）已卸载，现 7 张卡全可用，分配从 **0** 开始（较上一版整体 -1）。
- **暂不部署 `cloud-fast`**：需 `tensor-parallel-size 2` 占 2 张卡；GPU6 预留，另需再腾一张（如停用一组慢模型）后上线。
- `moon-fast`（4002）不在旧文档中，按「快模型」沿用 20480 / seqs 30；单独占 GPU5，util 保留 0.5。

## 进程一览

| PM2 名称 | 端口 | 模型 | max-model-len | GPU | max_num_seqs | gpu-mem-util | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 4010-embedding-c0 | 4010 | embedding | 512 | 0 | 3 | 0.1 | RAG 向量 |
| 4001-star-fast-c2 | 4001 | star-fast | 20480 | 2 | 30 | 0.25 | 含 LoRA |
| 4002-moon-fast-c5 | 4002 | moon-fast | 20480 | 5 | 30 | 0.5 | 快模型（非旧文档项） |
| 4003-star-slow-c0 | 4003 | star-slow | 30720 | 0 | 30 | 0.2 | 慢模型池 |
| 4003-star-slow-c1 | 4003 | star-slow | 30720 | 1 | 30 | 0.2 | |
| 4003-star-slow-c2 | 4003 | star-slow | 30720 | 2 | 30 | 0.2 | |
| 4003-star-slow-c3 | 4003 | star-slow | 30720 | 3 | 30 | 0.2 | |
| 4003-star-slow-c4 | 4003 | star-slow | 30720 | 4 | 30 | 0.2 | |
| 4004-moon-slow-c0 | 4004 | moon-slow | 30720 | 0 | 30 | 0.48 | 慢模型池 |
| 4004-moon-slow-c1 | 4004 | moon-slow | 30720 | 1 | 30 | 0.48 | |
| 4004-moon-slow-c2 | 4004 | moon-slow | 30720 | 2 | 30 | 0.48 | |
| 4004-moon-slow-c3 | 4004 | moon-slow | 30720 | 3 | 30 | 0.48 | |
| 4004-moon-slow-c4 | 4004 | moon-slow | 30720 | 4 | 30 | 0.48 | |

同端口多实例（4003、4004）由上游负载均衡转发；各实例绑定不同 GPU。  
单卡 util 累加估算：GPU0≈0.78（star-slow+moon-slow+embedding）、GPU1≈0.68、GPU2≈0.93（star-slow+moon-slow+star-fast，最紧）、GPU3≈0.68、GPU4≈0.68、GPU5≈0.5（moon-fast）、GPU6 空闲（预留 cloud-fast）。

---

## 4010 embedding（RAG 向量）

```bash
pm2 start bash --name 4010-embedding-c0 -- -c "CUDA_VISIBLE_DEVICES=0 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/embedding --port 4010 --served-model-name vllm --max-model-len 512 --dtype float16 --max_num_seqs 3 --gpu-memory-utilization 0.1"
```

---

## 4001 star-fast（快模型 + LoRA）

```bash
pm2 start bash --name 4001-star-fast-c2 -- -c "CUDA_VISIBLE_DEVICES=2 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-fast/ --port 4001 --served-model-name vllm --max-model-len 20480 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.25 --enable-lora --fully-sharded-loras --lora-modules sft_extract_mr_type=/root/.cache/huggingface/hub/weights/sft_extract_mr_type sft_extract_occur_at=/root/.cache/huggingface/hub/weights/sft_extract_occur_at sft_summary_emr=/root/.cache/huggingface/hub/weights/sft_summary_emr"
```

---

## 4002 moon-fast（快模型）

```bash
pm2 start bash --name 4002-moon-fast-c5 -- -c "CUDA_VISIBLE_DEVICES=5 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/moon-fast --port 4002 --served-model-name vllm --max-model-len 20480 --max_num_seqs 30 --dtype float16 --gpu-memory-utilization 0.5"
```

---

## 4003 star-slow（慢模型池）

```bash
pm2 start bash --name 4003-star-slow-c0 -- -c "CUDA_VISIBLE_DEVICES=0 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.2"
```

```bash
pm2 start bash --name 4003-star-slow-c1 -- -c "CUDA_VISIBLE_DEVICES=1 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.2"
```

```bash
pm2 start bash --name 4003-star-slow-c2 -- -c "CUDA_VISIBLE_DEVICES=2 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.2"
```

```bash
pm2 start bash --name 4003-star-slow-c3 -- -c "CUDA_VISIBLE_DEVICES=3 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.2"
```

```bash
pm2 start bash --name 4003-star-slow-c4 -- -c "CUDA_VISIBLE_DEVICES=4 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.2"
```

---

## 4004 moon-slow（慢模型池）

```bash
pm2 start bash --name 4004-moon-slow-c0 -- -c "CUDA_VISIBLE_DEVICES=0 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/moon-slow --port 4004 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.48"
```

```bash
pm2 start bash --name 4004-moon-slow-c1 -- -c "CUDA_VISIBLE_DEVICES=1 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/moon-slow --port 4004 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.48"
```

```bash
pm2 start bash --name 4004-moon-slow-c2 -- -c "CUDA_VISIBLE_DEVICES=2 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/moon-slow --port 4004 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.48"
```

```bash
pm2 start bash --name 4004-moon-slow-c3 -- -c "CUDA_VISIBLE_DEVICES=3 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/moon-slow --port 4004 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.48"
```

```bash
pm2 start bash --name 4004-moon-slow-c4 -- -c "CUDA_VISIBLE_DEVICES=4 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/moon-slow --port 4004 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.48"
```

---

## cloud-fast（暂不部署，留档）

> 待 GPU 资源就绪后再上线；需占 2 张卡（`tensor-parallel-size 2`）。目前仅 GPU6 空闲，需再腾一张（如停一组慢模型）后再改 `CUDA_VISIBLE_DEVICES`。

```bash
# 暂不执行；部署前请确认两张空闲卡并改 CUDA_VISIBLE_DEVICES（示例 5,6）
pm2 start bash --name 4006-cloud-fast-c5-6 -- -c "CUDA_VISIBLE_DEVICES=5,6 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/cloud-fast --port 4006 --served-model-name vllm --max-model-len 30720 --max_num_seqs 15 --tensor-parallel-size 2 --dtype float16 --gpu-memory-utilization 0.95"
```

---

## 运维补充

- 启动后保存：`pm2 save`
- 负载监控：`bash scripts/GPU_SERVER/vllm_load.sh`（在 GPU 服务器执行）
- 与 agent-qc-node 环境变量对应（见 `0903.md`）：`LLM2_SERVER_ROOT`（fast）、`LLM3_SERVER_ROOT`（slow）、`RAG_SERVER_ROOT`（embedding 4010）
- 若某卡 OOM：慢模型 util 可再下调（star-slow 0.2→0.18 / moon-slow 0.48→0.45），或把 GPU2 的 star-fast 迁到空闲的 GPU6
