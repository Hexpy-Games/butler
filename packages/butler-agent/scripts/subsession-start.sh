#!/usr/bin/env bash
# subsession-start.sh <project_name> <project_path> <message> <thread_id> <chat_id>
set -euo pipefail

BUTLER_HOME="${BUTLER_HOME:-$HOME/butler}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/butler-runtime.sh
source "${SCRIPT_DIR}/lib/butler-runtime.sh"
butler_use_runtime || { echo "Butler runtime not available. Re-run install.sh." >&2; exit 1; }

PROJECT_NAME="${1:?Usage: subsession-start.sh <project_name> <project_path> <message> <thread_id> <chat_id>}"
PROJECT_PATH="${2:?Missing project_path}"
MESSAGE="${3:?Missing message}"
THREAD_ID="${4:?Missing thread_id}"
CHAT_ID="${5:?Missing chat_id}"

CONFIG_RUNTIME="$(jq -r '.system.runtime // empty' "$BUTLER_DATA/butler.config.json" 2>/dev/null || true)"
BUTLER_RUNTIME_EFFECTIVE="${BUTLER_RUNTIME:-${CONFIG_RUNTIME:-codex-api}}"

ACTIVITY_DIR="$BUTLER_DATA/config/subsession-activity"
mkdir -p "$ACTIVITY_DIR"

append_inbound_transcript() {
  local project_key pointer_file session_id attempt
  if [[ -z "${BUTLER_INBOUND_CHAT_ID:-}" ]]; then
    return 0
  fi

  project_key=$(printf '%s' "$PROJECT_NAME" | tr -c 'A-Za-z0-9._-' '_')
  pointer_file="$BUTLER_DATA/config/subsession-sessions/${project_key}.txt"
  for attempt in 1 2 3 4 5; do
    session_id="$(cat "$pointer_file" 2>/dev/null | tr -d '\n' || true)"
    if [[ -n "$session_id" ]]; then
      BUTLER_INBOUND_TEXT="$MESSAGE" \
        "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/session-transcript.ts" inbound-from-env "$session_id" >/dev/null 2>&1 || true
      return 0
    fi
    sleep 1
  done
}

date +%s > "$ACTIVITY_DIR/${PROJECT_NAME}.txt"
PROJECT_PATH="${PROJECT_PATH/#\~/$HOME}"
exec "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/native-steward-turn.ts" \
  "$PROJECT_NAME" "$PROJECT_PATH" "$MESSAGE" "$THREAD_ID" "$CHAT_ID"

append_inbound_transcript

echo "[subsession-start] Native steward message routed to: $PROJECT_NAME"
