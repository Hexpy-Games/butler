#!/usr/bin/env bash
# resolve-chat-ids.sh — outputs one chat ID per line
# Resolves from: access.json (allowFrom + groups keys), env, config
set -euo pipefail

BUTLER_HOME="${BUTLER_HOME:-$HOME/butler}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"

# Priority 1: access.json (allowFrom + groups keys)
ACCESS_FILE="${BUTLER_DATA:-$HOME/.butler}/config/telegram-access.json"
if [ -f "$ACCESS_FILE" ] && command -v jq &>/dev/null; then
  IDS=$(jq -r '(.allowFrom[]? // empty), (.groups // {} | keys[])' "$ACCESS_FILE" 2>/dev/null || echo "")
  if [ -n "$IDS" ]; then
    echo "$IDS"
    exit 0
  fi
fi

# Priority 2: BUTLER_NOTIFY_CHAT_IDS env (space-separated)
if [ -n "${BUTLER_NOTIFY_CHAT_IDS:-}" ]; then
  set -f  # disable glob expansion on unquoted split
  for cid in $BUTLER_NOTIFY_CHAT_IDS; do
    echo "$cid"
  done
  set +f
  exit 0
fi

# Priority 3: TELEGRAM_CHAT_ID env
if [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  echo "$TELEGRAM_CHAT_ID"
  exit 0
fi

# Priority 4: butler.config.json
if command -v jq &>/dev/null && [ -f "$BUTLER_DATA/butler.config.json" ]; then
  TG_CHAT=$(jq -r '.telegram.chatId // empty' "$BUTLER_DATA/butler.config.json" 2>/dev/null || echo "")
  if [ -n "$TG_CHAT" ]; then
    echo "$TG_CHAT"
    exit 0
  fi
fi

# Nothing found — exit 0 with no output
exit 0
