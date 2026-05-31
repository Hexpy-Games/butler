#!/usr/bin/env bash
# send-telegram.sh <chat_id> <text> [thread_id] [format]
# Standalone Telegram message sender for steward sessions
set -euo pipefail

_butler_log() { local _l="${BUTLER_HOME:-$HOME/.butler}/packages/butler-agent/scripts/butler-log.sh"; [ -f "$_l" ] && . "$_l" && butler_log telegram "$@"; }

CHAT_ID="${1:?Usage: send-telegram.sh <chat_id> <text> [thread_id] [format]}"
TEXT="${2:?Missing text}"
THREAD_ID="${3:-}"
FORMAT="${4:-}"

# Load bot token
BUTLER_HOME="${BUTLER_HOME:-$HOME/butler}"
if [ -f "$BUTLER_DATA/.env" ]; then
  set +u; source "$BUTLER_DATA/.env"; set -u
fi
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN not set}"

# Configurable API base for testing (default: https://api.telegram.org)
API_BASE="${TELEGRAM_API_URL:-https://api.telegram.org}"

# Build curl args
ARGS=(-sf -X POST "${API_BASE}/bot${BOT_TOKEN}/sendMessage"
  -d "chat_id=${CHAT_ID}"
  --data-urlencode "text=${TEXT}")

if [ -n "$THREAD_ID" ]; then
  ARGS+=(-d "message_thread_id=${THREAD_ID}")
fi

if [ "$FORMAT" = "markdownv2" ]; then
  ARGS+=(-d "parse_mode=MarkdownV2")
fi

_butler_log INFO "Sending to chat_id=$CHAT_ID"
RESULT=$(curl "${ARGS[@]}" 2>&1) || { _butler_log ERROR "Send failed: $CHAT_ID"; echo "FAILED: curl exit $? — $RESULT" >&2; exit 1; }
if echo "$RESULT" | grep -q '"ok":true'; then
  MSG_ID=$(echo "$RESULT" | grep -o '"message_id":[0-9]*' | head -1 | cut -d: -f2)
  echo "sent (id: $MSG_ID)"
else
  echo "FAILED: $RESULT" >&2
  exit 1
fi
