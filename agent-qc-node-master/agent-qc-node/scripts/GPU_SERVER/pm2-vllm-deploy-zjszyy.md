# GPU 服务器 vLLM PM2 部署命令（gpu04）

> 整理自线上 `pm2 ls` / `pm2info` 启动参数。服务器：`gpu04`，Python 环境：`/opt/conda/envs/vllm`。  
> 统一写法：`pm2 start bash --name <进程名> -- -c "CUDA_VISIBLE_DEVICES=<卡号> <python> -m vllm.entrypoints.openai.api_server ..."`  
> 未在 `pm2info` 中显式给出 `CUDA_VISIBLE_DEVICES` 的实例，按进程名后缀 `cN` 推断为 GPU `N`（如 `c0`→0、`c11`→1 的第二实例）。

## 进程一览

| PM2 名称 | 端口 | 模型 | max-model-len | GPU | gpu-memory-utilization | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 4010-embedding-c1 | 4010 | embedding | 512 | 1 | 0.2 | RAG 向量 |
| 4001-star-fast-c0 | 4001 | star-fast | 20480 | 0 | 0.5 | 含 LoRA |
| 4003-star-slow-c0 | 4003 | star-slow | 30720 | 0 | 0.4 | 慢模型池 |
| 4003-star-slow-c1 | 4003 | star-slow | 30720 | 1 | 0.4 | |
| 4003-star-slow-c11 | 4003 | star-slow | 30720 | 1 | 0.4 | |
| 4003-star-slow-c2 | 4003 | star-slow | 30720 | 2 | 0.46 | |
| 4003-star-slow-c22 | 4003 | star-slow | 30720 | 2 | 0.46 | |
| 4003-star-slow-c3 | 4003 | star-slow | 30720 | 3 | 0.46 | pm2info 确认 |
| 4003-star-slow-c33 | 4003 | star-slow | 30720 | 3 | 0.46 | pm2info 确认 |
| 4004-moon-slow-c4 | 4004 | moon-slow | 30720 | 4 | 0.95 | pm2info 确认 |
| 4004-moon-slow-c5 | 4004 | moon-slow | 30720 | 5 | 0.95 | pm2info 确认 |
| 4004-moon-slow-c6 | 4004 | moon-slow | 30720 | 6 | 0.95 | pm2info 确认 |
| 4004-moon-slow-c7 | 4004 | moon-slow | 30720 | 7 | 0.95 | pm2info 确认 |

同端口多实例（如 4003、4004）由上游负载均衡转发；各实例绑定不同 GPU。

---

## 4010 embedding（RAG 向量）

```bash
pm2 start bash --name 4010-embedding-c1 -- -c "CUDA_VISIBLE_DEVICES=1 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/embedding --port 4010 --served-model-name vllm --max-model-len 512 --dtype float16 --max_num_seqs 3 --gpu-memory-utilization 0.2"
```

---

## 4001 star-fast（快模型 + LoRA）

```bash
pm2 start bash --name 4001-star-fast-c0 -- -c "CUDA_VISIBLE_DEVICES=0 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-fast/ --port 4001 --served-model-name vllm --max-model-len 20480 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.5 --enable-lora --fully-sharded-loras --lora-modules sft_extract_mr_type=/root/.cache/huggingface/hub/weights/sft_extract_mr_type sft_extract_occur_at=/root/.cache/huggingface/hub/weights/sft_extract_occur_at sft_summary_emr=/root/.cache/huggingface/hub/weights/sft_summary_emr"
```

---

## 4003 star-slow（慢模型池，gpu-memory 0.4）

```bash
pm2 start bash --name 4003-star-slow-c0 -- -c "CUDA_VISIBLE_DEVICES=0 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.4"
```

```bash
pm2 start bash --name 4003-star-slow-c1 -- -c "CUDA_VISIBLE_DEVICES=1 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.4"
```

```bash
pm2 start bash --name 4003-star-slow-c11 -- -c "CUDA_VISIBLE_DEVICES=1 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.4"
```

---

## 4003 star-slow（慢模型池，gpu-memory 0.46）

```bash
pm2 start bash --name 4003-star-slow-c2 -- -c "CUDA_VISIBLE_DEVICES=2 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.46"
```

```bash
pm2 start bash --name 4003-star-slow-c22 -- -c "CUDA_VISIBLE_DEVICES=2 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.46"
```

```bash
pm2 start bash --name 4003-star-slow-c3 -- -c "CUDA_VISIBLE_DEVICES=3 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.46"
```

```bash
pm2 start bash --name 4003-star-slow-c33 -- -c "CUDA_VISIBLE_DEVICES=3 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/star-slow --port 4003 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.46"
```

---

## 4004 moon-slow（慢模型池，gpu-memory 0.95）

```bash
pm2 start bash --name 4004-moon-slow-c4 -- -c "CUDA_VISIBLE_DEVICES=4 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/moon-slow --port 4004 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.95"
```

```bash
pm2 start bash --name 4004-moon-slow-c5 -- -c "CUDA_VISIBLE_DEVICES=5 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/moon-slow --port 4004 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.95"
```

```bash
pm2 start bash --name 4004-moon-slow-c6 -- -c "CUDA_VISIBLE_DEVICES=6 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/moon-slow --port 4004 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.95"
```

```bash
pm2 start bash --name 4004-moon-slow-c7 -- -c "CUDA_VISIBLE_DEVICES=7 /opt/conda/envs/vllm/bin/python -m vllm.entrypoints.openai.api_server --model /root/.cache/huggingface/hub/moon-slow --port 4004 --served-model-name vllm --max-model-len 30720 --dtype float16 --max_num_seqs 30 --gpu-memory-utilization 0.95"
```

---

## 运维补充

- 负载监控：`bash scripts/GPU_SERVER/vllm_load.sh`（需在 GPU 服务器上执行）
- 保存 PM2 列表：`pm2 save`
- 与 agent-qc-node 环境变量对应见 `0903.md`：`LLM2_SERVER_ROOT`（8b/fast）、`LLM3_SERVER_ROOT`（slow/thinking）、`RAG_SERVER_ROOT`（embedding 4010）
- `testEmrEvalAllInAI` 上下文超限与模型 `max-model-len` 相关：star-fast 20480、star-slow/moon-slow 30720 token
