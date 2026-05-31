#!/usr/bin/env bash
# notify-guard.sh — Deduplicated Telegram notifications
# Usage: source this file, then: notify_once <key> <ttl_seconds> <message>
# Requires: BUTLER_HOME, BUTLER_DATA set before sourcing.
#
# NOTE: Uses mkdir(2) as atomic mutex rather than flock — flock is not part of
# macOS base and PR #28's crash-loop recurrence traced to `flock: command not
# found` under `set -euo pipefail`, exiting start-butler.sh with code 127
# before the circuit breaker could run. mkdir is POSIX and always present.

[ -n "${_BUTLER_NOTIFY_GUARD_LOADED:-}" ] && return 0
_BUTLER_NOTIFY_GUARD_LOADED=1

if [ -z "${_BUTLER_TELEGRAM_LOADED:-}" ] && [ -f "${BUTLER_HOME}/packages/butler-agent/scripts/lib/telegram.sh" ]; then
  # shellcheck disable=SC1091
  source "${BUTLER_HOME}/packages/butler-agent/scripts/lib/telegram.sh"
fi

notify_once() {
  local KEY="$1"
  local TTL="$2"
  local MSG="$3"
  local LOCK_DIR="${BUTLER_DATA}/state/notify-locks"
  mkdir -p "$LOCK_DIR"
  local LOCK_FILE="$LOCK_DIR/$KEY"
  local MUTEX_DIR="$LOCK_DIR/$KEY.mutex.d"

  # Atomic mutex via mkdir — POSIX-portable, no flock dependency.
  local TRIES=0
  while ! mkdir "$MUTEX_DIR" 2>/dev/null; do
    TRIES=$((TRIES + 1))
    if [ "$TRIES" -ge 30 ]; then
      # Stale mutex? Force-clear if older than 30s, otherwise give up quietly.
      local MUTEX_MTIME NOW AGE
      MUTEX_MTIME=$(stat -f %m "$MUTEX_DIR" 2>/dev/null || stat -c %Y "$MUTEX_DIR" 2>/dev/null || echo 0)
      NOW=$(date +%s)
      AGE=$((NOW - MUTEX_MTIME))
      if [ "$AGE" -gt 30 ]; then
        rmdir "$MUTEX_DIR" 2>/dev/null || true
        continue
      fi
      return 0
    fi
    sleep 0.1
  done

  local SHOULD_SEND=1
  if [ -f "$LOCK_FILE" ]; then
    local MTIME NOW AGE
    MTIME=$(stat -f %m "$LOCK_FILE" 2>/dev/null || stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    AGE=$((NOW - MTIME))
    if [ "$AGE" -lt "$TTL" ]; then
      SHOULD_SEND=0
    fi
  fi

  if [ "$SHOULD_SEND" -eq 1 ]; then
    touch "$LOCK_FILE"
    notify_telegram "$MSG" || true
  fi

  rmdir "$MUTEX_DIR" 2>/dev/null || true
  return 0
}
