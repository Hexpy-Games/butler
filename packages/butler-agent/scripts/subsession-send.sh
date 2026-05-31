#!/usr/bin/env bash
# subsession-send.sh <project_name> <message> <thread_id> <chat_id>
set -euo pipefail

# Cleanup temp message files on exit (from this invocation)
_cleanup_msg_file() { [ -n "${MSG_FILE:-}" ] && rm -f "$MSG_FILE" 2>/dev/null || true; }
trap _cleanup_msg_file EXIT

# Periodic cleanup: remove butler-msg temp files older than 1 hour
find /tmp -maxdepth 1 -name 'butler-msg-*.md' -type f -mmin +60 -delete 2>/dev/null || true

BUTLER_HOME="${BUTLER_HOME:-$HOME/butler}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/butler-runtime.sh
source "${SCRIPT_DIR}/lib/butler-runtime.sh"
butler_use_runtime || { echo "Butler runtime not available. Re-run install.sh." >&2; exit 1; }
CONFIG_RUNTIME="$(jq -r '.system.runtime // empty' "$BUTLER_DATA/butler.config.json" 2>/dev/null || true)"
BUTLER_RUNTIME_EFFECTIVE="${BUTLER_RUNTIME:-${CONFIG_RUNTIME:-codex-api}}"

PROJECT_NAME="${1:?Usage: subsession-send.sh <project_name> <message> <thread_id> <chat_id>}"
MESSAGE="${2:?Missing message}"
THREAD_ID="${3:?Missing thread_id}"
CHAT_ID="${4:?Missing chat_id}"

ACTIVITY_DIR="$BUTLER_DATA/config/subsession-activity"
CONFIG="$BUTLER_DATA/butler.config.json"

append_inbound_transcript() {
  local project_key pointer_file session_id
  if [[ -z "${BUTLER_INBOUND_CHAT_ID:-}" ]]; then
    return 0
  fi

  project_key=$(printf '%s' "$PROJECT_NAME" | tr -c 'A-Za-z0-9._-' '_')
  pointer_file="$BUTLER_DATA/config/subsession-sessions/${project_key}.txt"
  session_id="$(cat "$pointer_file" 2>/dev/null | tr -d '\n' || true)"
  if [[ -z "$session_id" ]]; then
    return 0
  fi

  BUTLER_INBOUND_TEXT="$MESSAGE" \
    "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/session-transcript.ts" inbound-from-env "$session_id" >/dev/null 2>&1 || true
}

mkdir -p "$ACTIVITY_DIR"
date +%s > "$ACTIVITY_DIR/${PROJECT_NAME}.txt"
PROJECT_PATH=$(jq -r --arg name "$PROJECT_NAME" '.projects[] | select(.name == $name) | .path' "$CONFIG" | sed "s|~|$HOME|g")
if [[ -z "$PROJECT_PATH" ]]; then
  echo "[subsession-send] ERROR: No path found for '$PROJECT_NAME' in butler.config.json" >&2
  exit 1
fi

exec "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/native-steward-turn.ts" \
  "$PROJECT_NAME" \
  "$PROJECT_PATH" \
  "$MESSAGE" \
  "$THREAD_ID" \
  "$CHAT_ID"

append_inbound_transcript
