#!/usr/bin/env bash
# worker_supervisor.sh — Progress-aware supervisor for butler worker runs.
#
# Local liveness signals:
#   1. butler-owned worker transcript jsonl at $BUTLER_DATA/transcripts/<session-uuid>.jsonl
#   2. result.md / log.txt growth in $TASK_DIR
#
# Source this file, then call supervise_worker.

# Portable stat: prints "<mtime> <size>" for a file, or "0 0" if missing.
_supervisor_stat() {
  local f="$1"
  if [ ! -e "$f" ]; then
    echo "0 0"
    return
  fi
  if stat -f %m "$f" >/dev/null 2>&1; then
    # BSD/macOS
    local m s
    m=$(stat -f %m "$f" 2>/dev/null || echo 0)
    s=$(stat -f %z "$f" 2>/dev/null || echo 0)
    echo "$m $s"
  else
    # GNU/Linux
    local m s
    m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
    s=$(stat -c %s "$f" 2>/dev/null || echo 0)
    echo "$m $s"
  fi
}

# Compute the butler-owned worker transcript jsonl path for a given session UUID.
supervisor_jsonl_path() {
  local _cwd="$1" sid="$2"
  local data_dir="${BUTLER_DATA:-$HOME/.butler}"
  local safe_sid
  safe_sid=$(printf '%s' "$sid" | sed -e 's|[^A-Za-z0-9._-]|_|g')
  printf '%s' "$data_dir/transcripts/$safe_sid.jsonl"
}

# Append one JSONL line to the postmortem log.
_supervisor_postmortem() {
  local task_id="$1" reason="$2" exit_code="$3" elapsed="$4" jsonl="$5" log_txt="$6"
  local data_dir="${BUTLER_DATA:-$HOME/.butler}"
  local out="$data_dir/logs/timeouts.jsonl"
  mkdir -p "$(dirname "$out")"
  local ts
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","task_id":"%s","reason":"%s","exit":%d,"elapsed_sec":%d,"jsonl":"%s","log":"%s"}\n' \
    "$ts" "$task_id" "$reason" "$exit_code" "$elapsed" "$jsonl" "$log_txt" >> "$out"
}

# supervise_worker <worker_pid> <task_dir> <task_id> <session_uuid> <worker_cwd>
#
# Polls liveness signals at SAMPLE_INTERVAL until either:
#   - worker exits naturally (exit code passed through)
#   - no progress for NO_PROGRESS_SEC past initial window → exit 125
#   - elapsed >= MAX_WORKER_TIMEOUT → exit 124
#
# Tunables (env overrides):
#   BUTLER_SAMPLE_INTERVAL_SEC  (default 60)
#   BUTLER_INITIAL_WINDOW_SEC   (default 600)
#   BUTLER_NO_PROGRESS_SEC      (default 180)
#   BUTLER_EXTENSION_SEC        (default 300)
#   MAX_WORKER_TIMEOUT          (default 3600)
#   BUTLER_WARMUP_GRACE_SEC     (default 10)
supervise_worker() {
  local worker_pid="$1"
  local task_dir="$2"
  local task_id="$3"
  local session_uuid="$4"
  local worker_cwd="$5"

  local sample_interval="${BUTLER_SAMPLE_INTERVAL_SEC:-60}"
  local initial_window="${BUTLER_INITIAL_WINDOW_SEC:-600}"
  local no_progress="${BUTLER_NO_PROGRESS_SEC:-180}"
  local extension="${BUTLER_EXTENSION_SEC:-300}"
  local hard_ceiling="${MAX_WORKER_TIMEOUT:-3600}"
  local warmup="${BUTLER_WARMUP_GRACE_SEC:-10}"

  local jsonl_path log_path result_path
  jsonl_path=$(supervisor_jsonl_path "$worker_cwd" "$session_uuid")
  log_path="$task_dir/log.txt"
  result_path="$task_dir/result.md"

  echo "$jsonl_path" > "$task_dir/session_jsonl_path"

  local start_ts now_ts last_activity_ts deadline_ts
  start_ts=$(date +%s)
  last_activity_ts=$start_ts
  deadline_ts=$((start_ts + initial_window))

  local prev_jsonl prev_log prev_result
  prev_jsonl=$(_supervisor_stat "$jsonl_path")
  prev_log=$(_supervisor_stat "$log_path")
  prev_result=$(_supervisor_stat "$result_path")

  local exit_code=0
  local kill_reason=""
  local kill_exit=0

  while :; do
    sleep "$sample_interval" &
    local sleep_pid=$!
    wait "$sleep_pid" 2>/dev/null || true

    if ! kill -0 "$worker_pid" 2>/dev/null; then
      wait "$worker_pid" 2>/dev/null || exit_code=$?
      break
    fi

    now_ts=$(date +%s)
    local elapsed=$((now_ts - start_ts))

    local cur_jsonl cur_log cur_result
    cur_jsonl=$(_supervisor_stat "$jsonl_path")
    cur_log=$(_supervisor_stat "$log_path")
    cur_result=$(_supervisor_stat "$result_path")

    if [ "$cur_jsonl" != "$prev_jsonl" ] || [ "$cur_log" != "$prev_log" ] || [ "$cur_result" != "$prev_result" ]; then
      last_activity_ts=$now_ts
      local new_deadline=$((now_ts + extension))
      if [ "$new_deadline" -gt "$deadline_ts" ]; then
        deadline_ts=$new_deadline
      fi
      prev_jsonl=$cur_jsonl
      prev_log=$cur_log
      prev_result=$cur_result
    fi

    if [ "$elapsed" -ge "$hard_ceiling" ]; then
      kill_reason="hard_ceiling"
      kill_exit=124
      break
    fi

    if [ "$elapsed" -ge "$warmup" ]; then
      local silent=$((now_ts - last_activity_ts))
      if [ "$silent" -ge "$no_progress" ] && [ "$now_ts" -ge "$deadline_ts" ]; then
        kill_reason="no_progress"
        kill_exit=125
        break
      fi
    fi
  done

  if [ -n "$kill_reason" ]; then
    local elapsed_final=$(($(date +%s) - start_ts))
    kill -TERM "$worker_pid" 2>/dev/null || true
    local pgid
    pgid=$(cat "$task_dir/pgid" 2>/dev/null || echo "")
    local grace=0
    while [ "$grace" -lt 5 ] && kill -0 "$worker_pid" 2>/dev/null; do
      sleep 1
      grace=$((grace + 1))
    done
    if kill -0 "$worker_pid" 2>/dev/null; then
      kill -KILL "$worker_pid" 2>/dev/null || true
      if [ -n "$pgid" ]; then
        kill -KILL -- "-$pgid" 2>/dev/null || true
      fi
    fi
    wait "$worker_pid" 2>/dev/null || true
    _supervisor_postmortem "$task_id" "$kill_reason" "$kill_exit" "$elapsed_final" "$jsonl_path" "$log_path"
    return "$kill_exit"
  fi

  return "$exit_code"
}
