#!/usr/bin/env bash
# stop-butler.sh — Stop all butler services cleanly
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUTLER_HOME="${BUTLER_HOME:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
# shellcheck source=lib/butler-runtime.sh
source "${SCRIPT_DIR}/lib/butler-runtime.sh"
butler_use_runtime || true
CONFIG_RUNTIME=$(jq -r '.system.runtime // empty' "$BUTLER_DATA/butler.config.json" 2>/dev/null || echo "")
BUTLER_RUNTIME_EFFECTIVE="${BUTLER_RUNTIME:-${CONFIG_RUNTIME:-codex-api}}"
SESSION_FILE="$BUTLER_DATA/config/session-id.txt"
CONTROLLED_SHUTDOWN_FLAG="$BUTLER_DATA/locks/butler-controlled-shutdown"
NATIVE_MAIN_STATE_FILE="$BUTLER_DATA/state/butler-main-native.json"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [stop-butler] $*"; }

telegram_gateway_enabled() {
  local settings="$BUTLER_DATA/gateways/telegram.json"
  [ -f "$settings" ] || return 1
  if command -v jq >/dev/null 2>&1; then
    local enabled
    enabled="$(jq -r 'if has("enabled") then .enabled else false end' "$settings" 2>/dev/null || echo false)"
    [ "$enabled" = "true" ]
    return
  fi
  grep -Eq '"enabled"[[:space:]]*:[[:space:]]*true' "$settings" 2>/dev/null
}

log "Stopping all butler services..."

# Send shutdown notification via Telegram (before killing anything)
_notify_shutdown() {
  telegram_gateway_enabled || return 0
  if [ -f "$BUTLER_DATA/.env" ]; then
    set +u; source "$BUTLER_DATA/.env"; set -u
  fi
  local TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
  if [ -z "$TG_TOKEN" ]; then return 0; fi

  # Collect all chat IDs: access.json allowlist first, fallback to env/config
  local ACCESS_FILE="${BUTLER_DATA:-$HOME/.butler}/config/telegram-access.json"
  local CHAT_IDS=()
  if [ -f "$ACCESS_FILE" ]; then
    while IFS= read -r cid; do
      [ -n "$cid" ] && CHAT_IDS+=("$cid")
    done < <(jq -r '.allowFrom[]? // empty' "$ACCESS_FILE" 2>/dev/null)
  fi
  if [ ${#CHAT_IDS[@]} -eq 0 ]; then
    local TG_CHAT
    TG_CHAT=$(jq -r '.telegram.groupId // empty' "$BUTLER_DATA/butler.config.json" 2>/dev/null || echo "")
    if [ -z "$TG_CHAT" ]; then
      TG_CHAT="${TELEGRAM_CHAT_ID:-}"
    fi
    [ -z "$TG_CHAT" ] && return 0
    CHAT_IDS=("$TG_CHAT")
  fi

  for TG_CHAT in "${CHAT_IDS[@]}"; do
    curl -sf -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      -d "chat_id=${TG_CHAT}" \
      --data-urlencode "text=🛑 Butler shutting down (controlled stop)" >/dev/null 2>&1 || true
  done
  log "Shutdown notification sent via Telegram to ${#CHAT_IDS[@]} recipient(s)"
}
_notify_shutdown

# 0. Set shutdown flag so start-butler.sh's while-loop exits cleanly (code 0)
SHUTDOWN_FLAG="$BUTLER_DATA/locks/butler-shutdown"
mkdir -p "$(dirname "$SHUTDOWN_FLAG")"
touch "$SHUTDOWN_FLAG"
touch "$CONTROLLED_SHUTDOWN_FLAG"

if [ -f "$SESSION_FILE" ] && [ -n "${BUTLER_BUN:-}" ] && [ -f "$BUTLER_HOME/packages/butler-agent/scripts/session-runtime.ts" ]; then
  SESSION_ID=$(tr -d '[:space:]' < "$SESSION_FILE" 2>/dev/null || true)
  if [ -n "$SESSION_ID" ]; then
    "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/session-runtime.ts" transition "$SESSION_ID" closing "controlled-stop" butler >/dev/null 2>&1 || true
  fi
fi

# 1. Stop native supervisor services
log "Stopping native services..."
if [ -x "$BUTLER_HOME/packages/butler-agent/scripts/service-control.sh" ]; then
  "$BUTLER_HOME/packages/butler-agent/scripts/service-control.sh" stop 2>/dev/null || true
fi

# 2. Kill butler runtime processes by name
log "Killing butler processes..."
pkill -f "butler-mcp-server" 2>/dev/null || true
pkill -f "butler-telegram" 2>/dev/null || true
pkill -f "butler-embed-server" 2>/dev/null || true
# Fallback patterns for processes without exec -a naming
pkill -f ".butler/packages/butler-agent/src/interfaces/mcp-server/server.ts" 2>/dev/null || true
pkill -9 -f "packages/butler-agent/src/integrations/telegram.*server" 2>/dev/null || true

# Native services are normally stopped through durable supervisor state above.
# These patterns recover from older or damaged state files where a wrapper pid
# exited but its Bun child process kept running.
pkill -TERM -f "$BUTLER_HOME/packages/butler-agent/scripts/[s]tart-butler.sh" 2>/dev/null || true
pkill -TERM -f "$BUTLER_HOME/packages/butler-agent/scripts/[s]tart-embed-server.sh" 2>/dev/null || true
pkill -TERM -f "$BUTLER_HOME/packages/butler-agent/scripts/[n]ative-butler-main.ts" 2>/dev/null || true
pkill -TERM -f "$BUTLER_HOME/packages/butler-agent/scripts/[n]ative-scheduler.ts" 2>/dev/null || true
pkill -TERM -f "$BUTLER_HOME/packages/butler-agent/src/agent/cognition/memory/scripts/[s]ync-consumer.ts" 2>/dev/null || true
pkill -TERM -f "$BUTLER_HOME/packages/butler-agent/src/agent/cognition/memory/scripts/[e]mbed-server.ts" 2>/dev/null || true
pkill -TERM -f "$BUTLER_HOME/packages/butler-agent/src/interfaces/mcp-server/[w]atchdog.ts" 2>/dev/null || true

# 3. Kill orphaned worker processes
pkill -KILL -f 'run-worker\.ts' 2>/dev/null || true

# 4. Wait for processes to die
for i in $(seq 1 20); do
  if ! pgrep -f "butler-mcp-server|butler-telegram|butler-embed-server|.butler/packages/butler-agent/src/interfaces/mcp-server" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# 5. Native runtime shutdown cleanup
if [ -f "$NATIVE_MAIN_STATE_FILE" ]; then
  NATIVE_PID=$(jq -r '.pid // empty' "$NATIVE_MAIN_STATE_FILE" 2>/dev/null || true)
  if [ -n "$NATIVE_PID" ] && kill -0 "$NATIVE_PID" 2>/dev/null; then
    log "Killing native butler-main PID $NATIVE_PID..."
    kill "$NATIVE_PID" 2>/dev/null || true
    sleep 1
    kill -KILL "$NATIVE_PID" 2>/dev/null || true
  fi
  rm -f "$NATIVE_MAIN_STATE_FILE" 2>/dev/null || true
fi

log "All butler services stopped."
