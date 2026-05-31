#!/usr/bin/env bash
# dispatch.sh — Dispatch a task to a worker (blocking)
# Usage: dispatch.sh "<task_description>" "<project_path>"
set -euo pipefail

# Recursion guard: workers inherit BUTLER_WORKER=1 and must not re-dispatch.
# Prevents fork-bomb recursion (observed 6-level deep nesting in production).
if [[ "${BUTLER_WORKER:-0}" == "1" ]]; then
  echo "REFUSED: dispatch.sh called from within a worker process. Workers must complete the task themselves or surface questions to the principal via the result output — not spawn further workers." >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUTLER_HOME="${BUTLER_HOME:-$HOME/butler}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
export BUTLER_HOME BUTLER_DATA

# shellcheck source=lib/butler-runtime.sh
source "${SCRIPT_DIR}/lib/butler-runtime.sh"
butler_use_runtime || { echo "Butler runtime not available. Re-run install.sh." >&2; exit 1; }

# Source structured logging
if [ -f "${BUTLER_HOME}/packages/butler-agent/scripts/butler-log.sh" ]; then
  source "${BUTLER_HOME}/packages/butler-agent/scripts/butler-log.sh"
else
  butler_log() { :; }
fi

# Source progress-aware supervisor (no-op if absent → falls back to legacy path).
if [ -f "${BUTLER_HOME}/packages/butler-agent/scripts/lib/worker_supervisor.sh" ]; then
  # shellcheck source=lib/worker_supervisor.sh
  source "${BUTLER_HOME}/packages/butler-agent/scripts/lib/worker_supervisor.sh"
fi

TASK_DESC="${1:-}"
PROJECT_PATH="${2:-$HOME/dev}"
MODEL="${3:-}"
_ts=$(date +%s)
_rand=$(( RANDOM % 10000 ))
TASK_ID="${TASK_ID_OVERRIDE:-${_ts}${$}${_rand}}"
CONFIG_RUNTIME=$(jq -r '.system.runtime // empty' "$BUTLER_DATA/butler.config.json" 2>/dev/null || echo "")
BUTLER_RUNTIME_EFFECTIVE="${BUTLER_RUNTIME:-${CONFIG_RUNTIME:-codex-api}}"

if [[ -z "$TASK_DESC" ]]; then
  echo "Usage: dispatch.sh <task_description> [project_path]" >&2
  exit 1
fi

write_worker_activity() {
  local phase="$1"
  local status_line="$2"
  local updated_at
  updated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if command -v jq >/dev/null 2>&1; then
    local tmp_file
    tmp_file="$(mktemp "${TASK_DIR}/worker_activity.XXXXXX")" || return 0
    if [[ -s "$TASK_DIR/worker_activity.json" ]] && jq empty "$TASK_DIR/worker_activity.json" >/dev/null 2>&1; then
      jq \
        --arg phase "$phase" \
        --arg status_line "$status_line" \
        --arg updated_at "$updated_at" \
        '. + {phase:$phase,status_line:$status_line,updated_at:$updated_at}' \
        "$TASK_DIR/worker_activity.json" > "$tmp_file" 2>/dev/null && mv "$tmp_file" "$TASK_DIR/worker_activity.json" || rm -f "$tmp_file"
    else
      jq -n \
        --arg phase "$phase" \
        --arg status_line "$status_line" \
        --arg updated_at "$updated_at" \
        '{phase:$phase,status_line:$status_line,updated_at:$updated_at}' \
        > "$tmp_file" 2>/dev/null && mv "$tmp_file" "$TASK_DIR/worker_activity.json" || rm -f "$tmp_file"
    fi
  else
    printf '{"phase":"%s","status_line":"%s","updated_at":"%s"}\n' "$phase" "$status_line" "$updated_at" \
      > "$TASK_DIR/worker_activity.json" 2>/dev/null || true
  fi
}

worker_activity_phase() {
  if [[ ! -s "$TASK_DIR/worker_activity.json" ]]; then
    return 1
  fi
  jq -r '.phase // empty' "$TASK_DIR/worker_activity.json" 2>/dev/null || true
}

generate_worker_session_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
    return 0
  fi
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    local proc_uuid
    IFS= read -r proc_uuid < /proc/sys/kernel/random/uuid
    printf '%s\n' "$proc_uuid"
    return 0
  fi
  if [[ -n "${BUTLER_BUN:-}" && -x "$BUTLER_BUN" ]]; then
    "$BUTLER_BUN" -e 'console.log(crypto.randomUUID())'
    return 0
  fi
  return 1
}

# Check if TASK_DESC is actually a task_id pointing to an existing plan
PLANNED_DISPATCH=false
if [[ -f "$BUTLER_DATA/tasks/$TASK_DESC/plan.md" ]]; then
  PLANNED_DISPATCH=true
  TASK_ID="$TASK_DESC"
  TASK_DIR="$BUTLER_DATA/tasks/$TASK_ID"

  # Verify status is approved before dispatching
  CURRENT_STATUS="$(cat "$TASK_DIR/status" 2>/dev/null || echo "")"
  if [[ "$CURRENT_STATUS" != "APPROVED" ]]; then
    echo "Error: task $TASK_ID status is '$CURRENT_STATUS', must be 'APPROVED' to dispatch." >&2
    exit 1
  fi

  # Read plan.md as the task description for the worker prompt
  TASK_DESC="$(cat "$TASK_DIR/plan.md")"
  # Read project path from plan frontmatter if not overridden by arg
  if [[ "$PROJECT_PATH" = "$HOME/dev" ]]; then
    PLAN_PROJECT="$(sed -n 's/^project: *//p' "$TASK_DIR/plan.md" | head -1)"
    if [[ -n "$PLAN_PROJECT" ]]; then
      PROJECT_PATH="$PLAN_PROJECT"
    fi
  fi
  # Read model from plan frontmatter if not provided
  if [[ -z "$MODEL" ]]; then
    PLAN_MODEL="$(sed -n 's/^model: *//p' "$TASK_DIR/plan.md" | head -1)"
    if [[ -n "$PLAN_MODEL" ]]; then
      MODEL="$PLAN_MODEL"
    fi
  fi

  # Update status to RUNNING
  echo "RUNNING" > "$TASK_DIR/status"
  butler_log tasks INFO "plan_dispatched: id=$TASK_ID status=RUNNING"
else
  # Standard direct dispatch — create new task dir
  TASK_DIR="$BUTLER_DATA/tasks/$TASK_ID"
  mkdir -p "$TASK_DIR"

  echo "$TASK_DESC" > "$TASK_DIR/request.md"
  PROJECT_NAME="$(basename "$PROJECT_PATH")"
  if [ "$PROJECT_NAME" = "dev" ] || [ "$PROJECT_NAME" = "${USER:-}" ]; then
    PROJECT_NAME="general"
  fi
  echo "$PROJECT_NAME" > "$TASK_DIR/project"
  echo "RUNNING" > "$TASK_DIR/status"
fi
write_worker_activity "orienting" "Orienting: checking the request and workspace."

# Log task creation
butler_log tasks INFO "Task created: id=$TASK_ID request=\"$(echo "$TASK_DESC" | head -c 50)\""
START_TIME=$(date +%s)

MEMORY_CONTEXT="No Butler memory context files are currently present. Do not fail the task because memory context is absent; proceed from the task description and project files."
MEMORY_FILES=(
  "$BUTLER_DATA/memory/core.md"
  "$BUTLER_DATA/memory/user-profile.md"
  "$BUTLER_DATA/memory/hot/cache.md"
  "$BUTLER_DATA/personas/active.md"
  "$BUTLER_DATA/eol.md"
)
AVAILABLE_MEMORY=()
for memory_file in "${MEMORY_FILES[@]}"; do
  if [[ -f "$memory_file" ]]; then
    AVAILABLE_MEMORY+=("$memory_file")
  fi
done
if [[ "${#AVAILABLE_MEMORY[@]}" -gt 0 ]]; then
  MEMORY_CONTEXT="Optional Butler memory context files are available. Read only the files relevant to the task; if any file is missing or unreadable, continue without failing the task."
  for memory_file in "${AVAILABLE_MEMORY[@]}"; do
    MEMORY_CONTEXT="${MEMORY_CONTEXT}
- ${memory_file}"
  done
fi
PROMPT="Task ID: $TASK_ID
Project path: $PROJECT_PATH

$MEMORY_CONTEXT

Task:
$TASK_DESC"

CONFIG_TIMEOUT=$(jq -r '.timeouts.workerDefaultSec // empty' "$BUTLER_DATA/butler.config.json" 2>/dev/null || echo "")
WORKER_TIMEOUT=${WORKER_TIMEOUT:-${CONFIG_TIMEOUT:-1200}}

# Smart-timeout toggle. Default on; BUTLER_SMART_TIMEOUT=0 reverts to the
# coarse `timeout(1)` wrapper (rollback path during v0.1.0).
SMART_TIMEOUT="${BUTLER_SMART_TIMEOUT:-1}"
if ! command -v supervise_worker >/dev/null 2>&1; then
  SMART_TIMEOUT=0
fi

# Run worker synchronously (blocking)
cd "$PROJECT_PATH" 2>/dev/null || cd "$HOME"
WORKER_CWD="$(pwd)"
MODEL_ARGS=()
if [ -n "$MODEL" ]; then
  MODEL_ARGS=(--model "$MODEL")
fi

# $$ is the PID of this dispatch script. Since dispatch.sh is the process group
# leader, $$ == PGID of the group. Stored as "pgid" because it is used via
# `kill -- -$PGID` to terminate the entire worker process group at once.
echo $$ > "$TASK_DIR/pgid"

SESSION_ID_FILE="$TASK_DIR/session_id"
if [[ -s "$SESSION_ID_FILE" ]]; then
  SESSION_UUID="$(tr -d '[:space:]' < "$SESSION_ID_FILE")"
else
  SESSION_UUID="$(generate_worker_session_uuid)"
  echo "$SESSION_UUID" > "$SESSION_ID_FILE"
fi

if [[ -f "$BUTLER_HOME/packages/butler-agent/scripts/worker-transcript.ts" ]]; then
  "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/worker-transcript.ts" \
    start "$SESSION_UUID" "$TASK_DIR" "$PROJECT_PATH" "$BUTLER_RUNTIME_EFFECTIVE" "$MODEL" \
    >/dev/null 2>&1 || true
fi

EXIT_CODE=0
write_worker_activity "planning" "Planning: structuring the worker phase and step path."

if [ "$SMART_TIMEOUT" = "1" ]; then
  BUTLER_ROLE=worker \
  BUTLER_WORKER=1 \
  "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/run-worker.ts" "$TASK_DIR" "$PROJECT_PATH" "$MODEL" \
    < /dev/null \
    > "$TASK_DIR/result.md" 2>"$TASK_DIR/log.txt" &
  WORKER_PID=$!
  echo $WORKER_PID > "$TASK_DIR/pid"

  supervise_worker "$WORKER_PID" "$TASK_DIR" "$TASK_ID" "$SESSION_UUID" "$WORKER_CWD" || EXIT_CODE=$?
else
  BUTLER_ROLE=worker \
  BUTLER_WORKER=1 \
  timeout "$WORKER_TIMEOUT" "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/run-worker.ts" "$TASK_DIR" "$PROJECT_PATH" "$MODEL" \
    < /dev/null \
    > "$TASK_DIR/result.md" 2>"$TASK_DIR/log.txt" &
  WORKER_PID=$!
  echo $WORKER_PID > "$TASK_DIR/pid"
  wait $WORKER_PID || EXIT_CODE=$?
fi

DURATION=$(($(date +%s) - START_TIME))

if [ "$EXIT_CODE" -eq 124 ]; then
  echo "TIMEOUT: hard ceiling reached (${MAX_WORKER_TIMEOUT:-3600}s)" >> "$TASK_DIR/result.md"
  echo 'FAILED' > "$TASK_DIR/status"
  write_worker_activity "failed" "Failed: worker reached the hard timeout."
  butler_log tasks ERROR "Task $TASK_ID completed (exit=124 hard_ceiling, ${DURATION}s)"
elif [ "$EXIT_CODE" -eq 125 ]; then
  echo "TIMEOUT: no progress for ${BUTLER_NO_PROGRESS_SEC:-180}s past initial window" >> "$TASK_DIR/result.md"
  echo 'FAILED' > "$TASK_DIR/status"
  write_worker_activity "failed" "Failed: worker stopped after no-progress timeout."
  butler_log tasks ERROR "Task $TASK_ID completed (exit=125 no_progress, ${DURATION}s)"
elif [ "$EXIT_CODE" -eq 126 ]; then
  echo "TIMEOUT: deadlock pattern detected" >> "$TASK_DIR/result.md"
  echo 'FAILED' > "$TASK_DIR/status"
  write_worker_activity "failed" "Failed: worker stopped after deadlock detection."
  butler_log tasks ERROR "Task $TASK_ID completed (exit=126 deadlock, ${DURATION}s)"
elif [ $EXIT_CODE -eq 0 ]; then
  write_worker_activity "consolidating" "Consolidating: preparing worker evidence for review."
  echo 'DONE' > "$TASK_DIR/status"
  write_worker_activity "complete" "Complete: worker finished successfully."
  butler_log tasks INFO "Task $TASK_ID completed (exit=0, ${DURATION}s)"
else
  echo "EXIT_CODE: $EXIT_CODE" >> "$TASK_DIR/result.md"
  echo 'FAILED' > "$TASK_DIR/status"
  write_worker_activity "failed" "Failed: worker exited before completion."
  butler_log tasks ERROR "Task $TASK_ID completed (exit=$EXIT_CODE, ${DURATION}s)"
fi

TASK_STATUS_AFTER_RUN="$(cat "$TASK_DIR/status" 2>/dev/null || echo FAILED)"
if [[ -f "$BUTLER_HOME/packages/butler-agent/scripts/worker-transcript.ts" ]]; then
  "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/worker-transcript.ts" \
    finish "$SESSION_UUID" "$TASK_DIR" "$PROJECT_PATH" "$BUTLER_RUNTIME_EFFECTIVE" "$TASK_STATUS_AFTER_RUN" "$EXIT_CODE" "$DURATION" "$MODEL" \
    >/dev/null 2>&1 || true
fi

# Auto-review if plan-based task completed successfully
if [[ -f "$TASK_DIR/plan.md" && "$(cat "$TASK_DIR/status")" == "DONE" ]]; then
  butler_log tasks INFO "auto_review_started: id=$TASK_ID"
  write_worker_activity "verifying" "Verifying: reviewing worker output."
  REVIEW_CMD="${REVIEW_CMD:-${SCRIPT_DIR}/review.sh}"
  if "$REVIEW_CMD" "$TASK_ID" > /dev/null 2>&1; then
    butler_log tasks INFO "auto_review_completed: id=$TASK_ID"
    write_worker_activity "reporting" "Reporting: preparing reviewed worker result for Butler synthesis."
  else
    butler_log tasks ERROR "auto_review_failed: id=$TASK_ID"
  fi
fi

FINAL_STATUS_FOR_ACTIVITY="$(cat "$TASK_DIR/status" 2>/dev/null || echo FAILED)"
if [[ "$FINAL_STATUS_FOR_ACTIVITY" == "DONE" || "$FINAL_STATUS_FOR_ACTIVITY" == "REVIEWED" ]]; then
  write_worker_activity "complete" "Complete: worker result is ready."
elif [[ "$FINAL_STATUS_FOR_ACTIVITY" == "FAILED" ]]; then
  if [[ "$(worker_activity_phase)" != "failed" ]]; then
    write_worker_activity "failed" "Failed: worker result needs review."
  fi
fi

# Output result to stdout
cat "$TASK_DIR/result.md" 2>/dev/null

# Exit with appropriate code
FINAL_STATUS="$(cat "$TASK_DIR/status")"
if [[ "$FINAL_STATUS" == "DONE" || "$FINAL_STATUS" == "REVIEWED" ]]; then
  exit 0
else
  exit 1
fi
