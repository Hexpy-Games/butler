#!/usr/bin/env bash
# subsession-stop.sh <project_name>
set -euo pipefail

PROJECT_NAME="${1:?Usage: subsession-stop.sh <project_name>}"

BUTLER_HOME="${BUTLER_HOME:-$HOME/butler}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/butler-runtime.sh
source "${SCRIPT_DIR}/lib/butler-runtime.sh"
butler_use_runtime || true
CONFIG_RUNTIME="$(jq -r '.system.runtime // empty' "$BUTLER_DATA/butler.config.json" 2>/dev/null || true)"
BUTLER_RUNTIME_EFFECTIVE="${BUTLER_RUNTIME:-${CONFIG_RUNTIME:-codex-api}}"
ACTIVITY_DIR="$BUTLER_DATA/config/subsession-activity"
SESSION_POINTER_DIR="$BUTLER_DATA/config/subsession-sessions"
SESSION_RUNTIME_SCRIPT="$BUTLER_HOME/packages/butler-agent/scripts/session-runtime.ts"
PROJECT_KEY="$(printf '%s' "$PROJECT_NAME" | tr -c 'A-Za-z0-9._-' '_')"
SESSION_POINTER_FILE="$SESSION_POINTER_DIR/${PROJECT_KEY}.txt"
SESSION_ID=""
if [[ -f "$SESSION_POINTER_FILE" ]]; then
  SESSION_ID=$(tr -d '[:space:]' < "$SESSION_POINTER_FILE" 2>/dev/null || true)
fi

if [[ -n "$SESSION_ID" ]] && [[ -n "${BUTLER_BUN:-}" ]] && [[ -f "$SESSION_RUNTIME_SCRIPT" ]]; then
  "$BUTLER_BUN" run "$SESSION_RUNTIME_SCRIPT" transition "$SESSION_ID" closing "subsession-stop" steward >/dev/null 2>&1 || true
fi

if [[ -n "$SESSION_ID" ]] && [[ -n "${BUTLER_BUN:-}" ]] && [[ -f "$SESSION_RUNTIME_SCRIPT" ]]; then
  "$BUTLER_BUN" run "$SESSION_RUNTIME_SCRIPT" transition "$SESSION_ID" closed "subsession-stop" steward >/dev/null 2>&1 || true
fi

rm -f "$ACTIVITY_DIR/${PROJECT_NAME}.txt" 2>/dev/null || true
echo "[subsession-stop] Native steward session '$PROJECT_NAME' closed."
