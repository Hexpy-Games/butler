#!/usr/bin/env bash
# start-butler.sh — Run the native butler-main child process.
set -euo pipefail

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [butler-main] $*"
}

log "start-butler.sh started (PID: $$)"

# Ensure PATH includes common binary locations for direct shell launches.
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUTLER_HOME="${BUTLER_HOME:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"

# shellcheck source=lib/butler-runtime.sh
source "${SCRIPT_DIR}/lib/butler-runtime.sh"
butler_use_runtime || { log "Butler runtime not available. Re-run install.sh."; exit 1; }

# --- Instance mutex: only one start-butler.sh can run at a time ---
INSTANCE_LOCK="$BUTLER_DATA/locks/butler-instance.lock"
mkdir -p "$(dirname "$INSTANCE_LOCK")"
if ! (set -C; echo $$ > "$INSTANCE_LOCK") 2>/dev/null; then
  LOCK_PID=$(cat "$INSTANCE_LOCK" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "Another instance already running (pid $LOCK_PID), exiting cleanly"
    exit 0
  fi
  # Stale lock — reclaim
  log "Reclaiming stale instance lock (was pid $LOCK_PID)"
  echo $$ > "$INSTANCE_LOCK"
fi

# --- Circuit-breaker state. Declared early so the EXIT trap can reach it
# even if the script dies before the main monitoring loop.
SHUTDOWN_FLAG="$BUTLER_DATA/locks/butler-shutdown"
CONTROLLED_SHUTDOWN_FLAG="$BUTLER_DATA/locks/butler-controlled-shutdown"
RAPID_EXIT_FILE="$BUTLER_DATA/locks/butler-rapid-exits"
RAPID_EXIT_THRESHOLD=60
RAPID_EXIT_LIMIT=3
LAUNCH_TIME=$(date +%s)
CLEAN_EXIT=0

_record_exit() {
  local RC=$?
  rm -f "$INSTANCE_LOCK" "$BUTLER_DATA/locks/butler-launch.lock" 2>/dev/null || true
  # Graceful paths: CLEAN_EXIT set by the script, or SHUTDOWN_FLAG already present.
  if [ "${CLEAN_EXIT:-0}" = "1" ] || [ -f "$SHUTDOWN_FLAG" ]; then
    return 0
  fi
  local NOW UPTIME
  NOW=$(date +%s)
  UPTIME=$((NOW - LAUNCH_TIME))
  if [ "$UPTIME" -lt "$RAPID_EXIT_THRESHOLD" ]; then
    local COUNT=0
    [ -f "$RAPID_EXIT_FILE" ] && COUNT=$(cat "$RAPID_EXIT_FILE" 2>/dev/null || echo 0)
    COUNT=$((COUNT + 1))
    echo "$COUNT" > "$RAPID_EXIT_FILE" 2>/dev/null || true
    log "EXIT trap: rapid exit (rc=$RC uptime=${UPTIME}s count=${COUNT}/${RAPID_EXIT_LIMIT})"
    if [ "$COUNT" -ge "$RAPID_EXIT_LIMIT" ]; then
      log "EXIT trap: crash-loop detected — suppressing native restart"
      mkdir -p "$BUTLER_DATA/snapshots" 2>/dev/null || true
      echo "crash_loop" > "$BUTLER_DATA/snapshots/last-shutdown-reason" 2>/dev/null || true
      touch "$SHUTDOWN_FLAG" 2>/dev/null || true
      rm -f "$RAPID_EXIT_FILE" 2>/dev/null || true
      # exit 0 tells the native supervisor this was a controlled shutdown.
      exit 0
    fi
  else
    rm -f "$RAPID_EXIT_FILE" 2>/dev/null || true
  fi
  return 0
}

# Clear any stale shutdown flag from prior run BEFORE installing the trap,
# so the trap's `[ -f "$SHUTDOWN_FLAG" ]` check reflects only this run.
rm -f "$SHUTDOWN_FLAG" "$CONTROLLED_SHUTDOWN_FLAG"
trap _record_exit EXIT

# Run orphan cleanup before starting anything
CLEANUP_SCRIPT="$BUTLER_HOME/packages/butler-agent/scripts/cleanup-orphans.sh"
if [ -x "$CLEANUP_SCRIPT" ]; then
  log "Running orphan cleanup"
  "$CLEANUP_SCRIPT" 2>&1 || log "WARNING: orphan cleanup failed (non-fatal)"
fi
CONFIG_RUNTIME=$(jq -r '.system.runtime // empty' "$BUTLER_DATA/butler.config.json" 2>/dev/null || echo "")
BUTLER_RUNTIME_EFFECTIVE="${BUTLER_RUNTIME:-${CONFIG_RUNTIME:-codex-api}}"
SESSION_FILE="$BUTLER_DATA/config/session-id.txt"
SESSION_HISTORY_FILE="$BUTLER_DATA/config/session-history.txt"
NATIVE_MAIN_STATE_FILE="$BUTLER_DATA/state/butler-main-native.json"

save_current_session_id() {
  local session_id="$1"
  [ -z "$session_id" ] && return 1
  mkdir -p "$(dirname "$SESSION_FILE")"
  echo "$session_id" > "$SESSION_FILE"
  if ! grep -qxF "$session_id" "$SESSION_HISTORY_FILE" 2>/dev/null; then
    echo "$session_id" >> "$SESSION_HISTORY_FILE"
  fi
  echo "Session ID saved: $session_id"
  return 0
}

wait_for_local_session_pointer() {
  local timeout_sec="${BUTLER_SESSION_POINTER_WAIT_SEC:-20}"
  local waited=0

  while [ "$waited" -lt "$timeout_sec" ]; do
    if [ -s "$SESSION_FILE" ]; then
      local session_id
      session_id="$(tr -d '[:space:]' < "$SESSION_FILE" 2>/dev/null || true)"
      if [ -n "$session_id" ]; then
        save_current_session_id "$session_id" || true
        return 0
      fi
    fi
    sleep 1
    waited=$((waited + 1))
  done

  log "WARNING: session-id.txt was not populated by the session-start hook within ${timeout_sec}s"
  return 1
}

write_native_main_state() {
  mkdir -p "$(dirname "$NATIVE_MAIN_STATE_FILE")"
  cat > "$NATIVE_MAIN_STATE_FILE" <<EOF
{"pid":$$,"startedAt":"$(date -u +"%Y-%m-%dT%H:%M:%SZ")","runtime":"$BUTLER_RUNTIME_EFFECTIVE","launcher":"start-butler.sh"}
EOF
}

clear_native_main_state() {
  rm -f "$NATIVE_MAIN_STATE_FILE" 2>/dev/null || true
}

# Kill existing MCP server processes before starting
pkill -f ".butler/packages/butler-agent/src/interfaces/mcp-server/server.ts" 2>/dev/null || true

# Wait for processes to actually die (up to 10s) before proceeding
for i in $(seq 1 20); do
  if ! pgrep -f ".butler/packages/butler-agent/src/interfaces/mcp-server/server.ts" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
# Force kill if still alive after 10s
if pgrep -f ".butler/packages/butler-agent/src/interfaces/mcp-server/server.ts" >/dev/null 2>&1; then
  pkill -9 -f ".butler/packages/butler-agent/src/interfaces/mcp-server/server.ts" 2>/dev/null || true
  sleep 1
fi

# Kill orphaned worker processes from previous session
TASKS_DIR="$BUTLER_DATA/tasks"
if [ -d "$TASKS_DIR" ]; then
  for STATUS_FILE in "$TASKS_DIR"/*/status; do
    [ -f "$STATUS_FILE" ] || continue
    STATUS=$(cat "$STATUS_FILE" 2>/dev/null)
    [ "$STATUS" = "RUNNING" ] || continue
    TASK_DIR=$(dirname "$STATUS_FILE")
    PGID_FILE="$TASK_DIR/pgid"
    PID_FILE="$TASK_DIR/pid"
    if [ -f "$PGID_FILE" ]; then
      PGID=$(cat "$PGID_FILE" 2>/dev/null)
      [ -n "$PGID" ] && kill -KILL -- "-$PGID" 2>/dev/null || true
    elif [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE" 2>/dev/null)
      [ -n "$PID" ] && kill -KILL "$PID" 2>/dev/null || true
    fi
    echo "FAILED" > "$STATUS_FILE"
  done
fi
log "Starting native butler bootstrap (runtime: $BUTLER_RUNTIME_EFFECTIVE)"
rm -f "$SESSION_FILE"
write_native_main_state
# Keep the service process alive by running native butler-main.
# All exit paths below are handled by the EXIT trap (_record_exit):
#   - SHUTDOWN_FLAG present → trap treats as graceful, no counter increment
#   - CLEAN_EXIT=1 set      → trap treats as graceful, no counter increment
#   - anything else         → trap increments rapid-exit counter, trips breaker at limit
set +e
"$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/native-butler-main.ts"
RC=$?
set -e
clear_native_main_state

if [ "$RC" -eq 0 ] && [ -f "$SHUTDOWN_FLAG" ]; then
  CLEAN_EXIT=1
  rm -f "$RAPID_EXIT_FILE"
  exit 0
fi

if [ "$RC" -eq 0 ]; then
  log "Native butler bootstrap exited without shutdown flag; treating as crash"
  exit 1
fi

exit "$RC"
