#!/bin/bash
# 放置于GPU服务器上 
# vLLM 实时负载监控 — 每秒刷新，ESC / Ctrl+C 退出
# 用法 bash vllm_load.sh

R=$'\033[31m'; Y=$'\033[33m'; G=$'\033[32m'
C=$'\033[36m'; M=$'\033[35m'; DIM=$'\033[2m'
BOLD=$'\033[1m'; RESET=$'\033[0m'
ORANGE=$'\033[38;5;214m'; GRAY=$'\033[38;5;245m'
BG_HEAD=$'\033[48;5;237m'; BG_GROUP=$'\033[48;5;235m'

hide_cursor() { printf '\033[?25l'; }
show_cursor() { printf '\033[?25h'; }
cur()         { printf '\033[%d;%dH' "$(($1+1))" "$(($2+1))"; }
clear_s()     { printf '\033[2J\033[H'; }

cleanup() {
  show_cursor; tput rmcup 2>/dev/null
  printf "${RESET}\n退出监控。\n"; exit 0
}
trap cleanup INT TERM

# 提取模型名：4003-star-slow-c2 → star-slow
get_model() {
  local name=$1
  # 去掉开头端口前缀(数字-) 和结尾实例后缀(-cNN)
  echo "$name" | sed 's/^[0-9]*-//; s/-c[0-9]*$//'
}

get_instances() {
  pm2 jlist 2>/dev/null | python3 -c "
import sys, json, re
procs = json.load(sys.stdin)
for p in procs:
    name = p.get('name','')
    env  = p.get('pm2_env',{})
    args = ' '.join(str(a) for a in env.get('args',[]))
    m = re.search(r'--port[= ](\d+)', args)
    if not m: continue
    port = m.group(1)
    cuda = env.get('env',{}).get('CUDA_VISIBLE_DEVICES','')
    if not cuda:
        mc = re.search(r'CUDA_VISIBLE_DEVICES=(\S+)', args)
        cuda = mc.group(1) if mc else '?'
    print(f'{name}|{port}|{cuda}')
" 2>/dev/null
}

declare -A PORT_CACHE
fetch_metrics() {
  local port=$1
  if [[ -z "${PORT_CACHE[$port]+x}" ]]; then
    PORT_CACHE[$port]=$(curl -sf --max-time 2 "http://localhost:${port}/metrics" 2>/dev/null)
  fi
  echo "${PORT_CACHE[$port]}"
}

# 定宽打印（处理中文双宽字符偏移问题：表格区域全用英文/数字）
# 列宽定义（全ASCII）
C1=28   # Name
C2=6    # Port
C3=5    # GPU
C4=9    # Running
C5=9    # Waiting
C6=9    # KVCache
C7=6    # Status
TOTAL_W=$(( C1 + C2 + C3 + C4 + C5 + C6 + C7 + 2 ))

hline() { printf "${DIM}"; printf '─%.0s' $(seq 1 $TOTAL_W); printf "${RESET}\n"; }

render() {
  unset PORT_CACHE; declare -gA PORT_CACHE

  # 按模型分组统计
  declare -A MODEL_RUNNING MODEL_WAITING

  cur 0 0
  printf "${BOLD}${ORANGE} ⚡ vLLM 实时负载监控${RESET}"
  printf "  ${GRAY}ESC / Ctrl+C 退出  |  实例数: ${#ENTRIES[@]}${RESET}"
  # 右上角闪烁
  printf '%*s' $(( W - 32 )) ''
  (( TICK % 2 == 0 )) && printf "${G}◆${RESET}" || printf "${DIM}◇${RESET}"
  printf '\n'

  hline

  # 表头（纯ASCII，对齐稳定）
  printf "${BG_HEAD}${BOLD}"
  printf " %-*s %-*s %-*s %-*s %-*s %-*s %-*s" \
    $((C1-1)) "Name" $((C2-1)) "Port" $((C3-1)) "GPU" \
    $((C4-1)) "Running" $((C5-1)) "Waiting" $((C6-1)) "KVCache" $((C7-1)) "State"
  printf "${RESET}\n"

  hline

  local total_running=0 total_waiting=0
  local max_wait=0 max_wait_name=""

  for entry in "${ENTRIES[@]}"; do
    IFS='|' read -r NAME PORT CUDA <<< "$entry"
    METRICS=$(fetch_metrics "$PORT")
    MODEL=$(get_model "$NAME")

    if [[ -z "$METRICS" ]]; then
      printf " ${R}%-*s${RESET} %-*s %-*s ${DIM}%-*s %-*s %-*s${RESET} ${R}%-*s${RESET}\n" \
        $((C1-1)) "$NAME" $((C2-1)) "$PORT" $((C3-1)) "$CUDA" \
        $((C4-1)) "-" $((C5-1)) "-" $((C6-1)) "-" $((C7-1)) "dead"
      continue
    fi

    RUNNING=$(echo "$METRICS" | awk '/^vllm:num_requests_running/{printf "%.0f",$NF; exit}')
    WAITING=$(echo "$METRICS" | awk '/^vllm:num_requests_waiting/{printf "%.0f",$NF; exit}')
    KV_RAW=$(echo  "$METRICS" | awk '/^vllm:gpu_cache_usage_perc/{print $NF; exit}')
    RUNNING=${RUNNING:-0}; WAITING=${WAITING:-0}

    # KV Cache
    if [[ -n "$KV_RAW" && "$KV_RAW" != "0" ]]; then
      KV=$(awk "BEGIN{printf \"%.1f%%\", ${KV_RAW}*100}")
      KV_INT=$(awk "BEGIN{printf \"%d\", ${KV_RAW}*100}")
    else
      KV="N/A"; KV_INT=0
    fi

    (( total_running  += RUNNING ))
    (( total_waiting  += WAITING ))
    (( MODEL_RUNNING[$MODEL]  += RUNNING ))
    (( MODEL_WAITING[$MODEL]  += WAITING ))
    if (( WAITING > max_wait )); then max_wait=$WAITING; max_wait_name=$NAME; fi

    # 颜色选择
    (( WAITING > 20 )) && WC=$R || { (( WAITING > 5 )) && WC=$Y || WC=$G; }
    (( KV_INT  > 90 )) && KC=$R || { (( KV_INT  > 70 )) && KC=$Y || KC=$G; }
    (( RUNNING >  0 )) && DOT="${G}●${RESET}" || DOT="${DIM}○${RESET}"

    printf " ${C}%-*s${RESET} ${GRAY}%-*s${RESET} ${M}%-*s${RESET} ${G}%-*s${RESET} ${WC}%-*s${RESET} ${KC}%-*s${RESET} %s\n" \
      $((C1-1)) "$NAME"    $((C2-1)) "$PORT"    $((C3-1)) "$CUDA" \
      $((C4-1)) "$RUNNING" $((C5-1)) "$WAITING" $((C6-1)) "$KV" \
      "$DOT"
  done

  hline

  # ── 汇总：全部 ──────────────────────────────────────────────────
  printf " ${BOLD}${ORANGE}%-*s${RESET} ${GRAY}%-*s${RESET} %-*s ${BOLD}${G}%-*s${RESET} " \
    $((C1-1)) "汇总(全部)" $((C2-1)) "" $((C3-1)) "" $((C4-1)) "$total_running"
  (( total_waiting > 0 )) \
    && printf "${BOLD}${R}%-*s${RESET} " $((C5-1)) "$total_waiting" \
    || printf "${BOLD}${G}%-*s${RESET} " $((C5-1)) "$total_waiting"
  [[ -n "$max_wait_name" && $max_wait -gt 0 ]] \
    && printf "${GRAY}压力最大: ${Y}%s${RESET}\n" "$max_wait_name" \
    || printf "${GRAY}队列空闲${RESET}\n"

  # ── 汇总：按模型分组 ────────────────────────────────────────────
  # 获取唯一模型列表（保持顺序）
  local prev_models=()
  for entry in "${ENTRIES[@]}"; do
    IFS='|' read -r NAME _ _ <<< "$entry"
    m=$(get_model "$NAME")
    if [[ ! " ${prev_models[*]} " =~ " $m " ]]; then
      prev_models+=("$m")
    fi
  done

  printf "${BG_GROUP}"
  printf " %-*s %-*s %-*s %-*s %-*s\n" \
    $((C1-1)) "  模型分组" $((C2-1)) "" $((C3-1)) "" \
    $((C4-1)) "运行中" $((C5-1)) "等待中"
  printf "${RESET}"

  for model in "${prev_models[@]}"; do
    mr=${MODEL_RUNNING[$model]:-0}
    mw=${MODEL_WAITING[$model]:-0}
    (( mw > 10 )) && MWC=$R || { (( mw > 0 )) && MWC=$Y || MWC=$G; }
    printf "  ${GRAY}%-*s${RESET} %-*s %-*s ${G}%-*s${RESET} ${MWC}%-*s${RESET}\n" \
      $((C1-2)) "$model" $((C2-1)) "" $((C3-1)) "" \
      $((C4-1)) "$mr" $((C5-1)) "$mw"
  done

  hline

  # ── 图例 & 时间 ─────────────────────────────────────────────────
  printf "  ${G}● 空闲${RESET}  ${Y}● 排队${RESET}  ${R}● 高压${RESET}   ${GRAY}刷新时间: $(date '+%H:%M:%S')${RESET}\n"
}

# ─── Main ───────────────────────────────────────────────────────────
mapfile -t ENTRIES < <(get_instances)
if [[ ${#ENTRIES[@]} -eq 0 ]]; then
  echo "未找到 vLLM 实例，请确认 pm2 正在运行且包含 --port 参数。"
  exit 1
fi

tput smcup 2>/dev/null
hide_cursor
clear_s

TICK=0
W=$(tput cols 2>/dev/null || echo 100)

while true; do
  IFS= read -r -s -n1 -t3 KEY 2>/dev/null; RC=$?
  if [[ $RC -eq 0 ]]; then
    CODE=$(printf '%d' "'$KEY" 2>/dev/null || echo 0)
    [[ $CODE -eq 27 ]] && cleanup
  fi
  (( TICK++ ))
  if (( TICK % 30 == 0 )); then
    mapfile -t ENTRIES < <(get_instances)
    clear_s
  fi
  W=$(tput cols 2>/dev/null || echo 100)
  cur 0 0
  render
done
