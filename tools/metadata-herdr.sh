#!/bin/bash
# Phase 2B run as herdr agents: one interactive omp agent per batch file, in its own tab of a herdr workspace, N at once.
# Run it inside a herdr pane of that workspace, so it keeps going when the terminal that started it closes.
#
#   bash tools/metadata-herdr.sh <workspace id> <first batch>-<last batch> [parallel=8]
#
# A batch is done when `metadata-check --id <its ids>` passes; its tab is then closed (which ends the agent) and the
# next batch starts in a fresh agent. An agent that sits idle without passing, or runs past 45 min, is closed and the
# batch is logged as failed (re-run it later). Batches that already pass are skipped. Log: _batches/herdr-run.log.
# macOS /bin/bash 3.2: no associative arrays.
set -u
WS=$1; RANGE=$2; PAR=${3:-8}
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
B=catalog/metadata/_batches; LOG=$B/herdr-run.log
MODEL=deepseek/deepseek-v4.1-flash; MAX_MIN=45
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$LOG"; }
passes() { bun tools/metadata-check.mjs --id "$(cat $B/$1.ids)" >/dev/null 2>&1; }

queue=""; for n in $(seq ${RANGE%-*} ${RANGE#*-}); do [ -f $B/$n.md ] && ! passes $n && queue="$queue $n"; done
set -- $queue
log "start: $# batches to run, $PAR at once, workspace $WS"

slots=""   # entries n@tab@started_epoch@idle_count (herdr tab ids contain ":")
start_batch() {
  local n=$1 out pane tab
  out=$(herdr tab create --workspace "$WS" --cwd "$ROOT" --label "m$n" 2>&1)
  pane=$(echo "$out" | grep -o '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4)
  tab=$(echo "$out" | grep -o '"tab_id":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -z "$pane" ] || [ -z "$tab" ]; then log "batch $n: could not create a tab: $out"; return 1; fi
  sleep 2
  herdr agent start "m$n" --kind omp --pane "$pane" -- --model "$MODEL" --thinking max \
    --tools read,write,edit,bash,grep,glob,web_search --approval-mode yolo >/dev/null 2>&1
  sleep 8
  herdr agent prompt "m$n" "Read catalog/metadata/_batches/$n.md and do exactly what it says." >/dev/null 2>&1
  slots="$slots $n@$tab@$(date +%s)@0"
  log "batch $n: started (tab $tab)"
}

while [ $# -gt 0 ] || [ -n "$(echo $slots)" ]; do
  # fill free slots
  while [ $# -gt 0 ] && [ $(echo $slots | wc -w) -lt $PAR ]; do start_batch $1; shift; done
  sleep 60
  next=""
  for s in $slots; do
    n=${s%%@*}; r=${s#*@}; tab=${r%%@*}; r=${r#*@}; t0=${r%%@*}; idle=${r#*@}
    mins=$(( ($(date +%s) - t0) / 60 ))
    if passes $n; then
      herdr tab close "$tab" >/dev/null 2>&1; log "batch $n: done · check ok · $mins min"; continue
    fi
    if herdr agent read "m$n" 2>/dev/null | tail -c 3000 | grep -q '╭── π >' && [ $mins -ge 3 ]; then idle=$((idle + 1)); else idle=0; fi
    if [ $idle -ge 3 ] || [ $mins -ge $MAX_MIN ]; then
      herdr tab close "$tab" >/dev/null 2>&1; log "batch $n: FAILED · idle $idle · $mins min · check does not pass"; continue
    fi
    next="$next $n@$tab@$t0@$idle"
  done
  slots=$next
done
log "finished"
