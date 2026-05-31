#!/usr/bin/env bash
# telegram.sh — Shared Telegram notification helper
# Source this file and call: notify_telegram "message text"
# Requires: BUTLER_HOME, BUTLER_DATA set before sourcing.

# Idempotent sourcing guard
[ -n "${_BUTLER_TELEGRAM_LOADED:-}" ] && return 0
_BUTLER_TELEGRAM_LOADED=1

# Append a dropped-send entry to the audit log. Rotates at 1 MB → .1.
_telegram_log_silence() {
  local CHAT="$1" REASON="$2"
  local LOG_FILE="${TELEGRAM_SILENCE_LOG:-$BUTLER_DATA/logs/telegram-silence.log}"
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  if [ -f "$LOG_FILE" ]; then
    local SIZE
    SIZE=$(stat -f %z "$LOG_FILE" 2>/dev/null || stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$SIZE" -gt 1048576 ]; then
      mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
    fi
  fi
  printf '%s chat=%s reason=%s\n' "$(date -u +%FT%TZ)" "$CHAT" "$REASON" >> "$LOG_FILE" 2>/dev/null || true
}

notify_telegram() {
  local TEXT="$1"
  local SEND_SCRIPT="${BUTLER_HOME}/packages/butler-agent/scripts/send-telegram.sh"
  local RESOLVE_SCRIPT="${BUTLER_HOME}/packages/butler-agent/scripts/resolve-chat-ids.sh"

  # Load private runtime .env for bot token.
  if [ -f "$BUTLER_DATA/.env" ]; then
    set +u; source "$BUTLER_DATA/.env"; set -u
  fi
  local TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
  if [ -z "$TG_TOKEN" ]; then
    return 0
  fi

  # Resolve chat IDs via shared script
  local CHAT_IDS=()
  if [ -x "$RESOLVE_SCRIPT" ]; then
    while IFS= read -r cid; do
      [ -n "$cid" ] && CHAT_IDS+=("$cid")
    done < <("$RESOLVE_SCRIPT" 2>/dev/null)
  fi

  if [ ${#CHAT_IDS[@]} -eq 0 ]; then
    return 0
  fi

  # Send to all resolved chat IDs with one-shot retry. On persistent failure,
  # append to the silence log — never emit to stdout/stderr.
  local ANY_OK=false
  for TG_CHAT in "${CHAT_IDS[@]}"; do
    local EXIT=1
    if [ -x "$SEND_SCRIPT" ]; then
      "$SEND_SCRIPT" "$TG_CHAT" "$TEXT" "" "" >/dev/null 2>&1
      EXIT=$?
      if [ "$EXIT" -ne 0 ]; then
        sleep 2
        "$SEND_SCRIPT" "$TG_CHAT" "$TEXT" "" "" >/dev/null 2>&1
        EXIT=$?
      fi
    else
      curl -sf -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TG_CHAT}" \
        --data-urlencode "text=${TEXT}" >/dev/null 2>&1
      EXIT=$?
      if [ "$EXIT" -ne 0 ]; then
        sleep 2
        curl -sf -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
          --data-urlencode "chat_id=${TG_CHAT}" \
          --data-urlencode "text=${TEXT}" >/dev/null 2>&1
        EXIT=$?
      fi
    fi
    if [ "$EXIT" -eq 0 ]; then
      ANY_OK=true
    else
      _telegram_log_silence "$TG_CHAT" "exit=$EXIT"
    fi
  done

  # First successful send closes the startup grace window — the bot is proven alive.
  if [ "$ANY_OK" = true ] && [ -f "$BUTLER_DATA/state/startup-grace-until" ]; then
    rm -f "$BUTLER_DATA/state/startup-grace-until" 2>/dev/null || true
  fi

  return 0
}
