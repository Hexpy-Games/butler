#!/usr/bin/env bash
# butler-log.sh — Shared structured logging library
# Source this file in any script:
#   source "$BUTLER_HOME/packages/butler-agent/scripts/butler-log.sh"
# Then call:
#   butler_log <component> <level> <message>

# Idempotent sourcing guard
[ -n "${_BUTLER_LOG_LOADED:-}" ] && return 0
_BUTLER_LOG_LOADED=1

# Defaults
BUTLER_HOME="${BUTLER_HOME:-${HOME:-/tmp}/butler}"
BUTLER_DATA="${BUTLER_DATA:-${HOME:-/tmp}/.butler}"

# Portable ISO-8601 UTC timestamp helper (cached per epoch second)
_butler_ts() {
  local now
  now="$(date +%s)"
  if [ "${_BUTLER_LOG_TS_EPOCH:-}" = "$now" ] && [ -n "${_BUTLER_LOG_TS:-}" ]; then
    echo "$_BUTLER_LOG_TS"
    return
  fi
  _BUTLER_LOG_TS_EPOCH="$now"
  _BUTLER_LOG_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "$_BUTLER_LOG_TS"
}

# Main logging function
# Usage: butler_log <component> <level> <message>
# Components: hooks, tasks, system, doctor (or any string)
# Levels: ERROR, WARN, INFO, DEBUG
butler_log() {
  local component="${1:-system}"
  local level="${2:-INFO}"
  local message="${3:-}"

  # Suppress DEBUG unless BUTLER_LOG_DEBUG=1
  if [ "$level" = "DEBUG" ] && [ "${BUTLER_LOG_DEBUG:-}" != "1" ]; then
    return 0
  fi

  local timestamp
  timestamp="$(_butler_ts)"

  local log_line="[${timestamp}] [${component}] [${level}] ${message}"

  # Truncate extremely long messages (keep under 4096 chars)
  if [ "${#log_line}" -gt 4096 ]; then
    log_line="${log_line:0:4080}...(truncated)"
  fi

  local log_dir="${BUTLER_DATA}/logs"
  local log_file="${log_dir}/${component}.log"

  # Write to stderr if BUTLER_LOG_STDERR=1
  if [ "${BUTLER_LOG_STDERR:-}" = "1" ]; then
    echo "$log_line" >&2
  fi

  # Attempt to create log directory and write (no subshell — avoid fork overhead)
  mkdir -p "$log_dir" 2>/dev/null || true

  # Emergency truncation: if file exceeds max size, truncate to last 1000 lines
  # Uses flock to prevent concurrent truncation from multiple processes
  if [ -f "$log_file" ]; then
    local log_size
    log_size=$(wc -c < "$log_file" 2>/dev/null || echo 0)
    log_size=$(echo "$log_size" | tr -d ' ')
    local max_bytes="${BUTLER_LOG_MAX_BYTES:-52428800}"
    if [ "$log_size" -gt "$max_bytes" ] 2>/dev/null; then
      (
        flock -n 9 || return 0  # skip if another process is already truncating
        # Try tail by lines first; if still too large, truncate by bytes
        tail -n 1000 "$log_file" > "${log_file}.tmp.$$" 2>/dev/null || true
        tmp_size=$(wc -c < "${log_file}.tmp.$$" 2>/dev/null || echo 0)
        tmp_size=$(echo "$tmp_size" | tr -d ' ')
        if [ "$tmp_size" -gt "$max_bytes" ] 2>/dev/null; then
          # File has very long lines; truncate to last ~1MB
          tail -c 1048576 "$log_file" > "${log_file}.tmp.$$" 2>/dev/null || true
        fi
        mv "${log_file}.tmp.$$" "$log_file" 2>/dev/null || true
        echo "[$(_butler_ts)] [system] [WARN] Log truncated (size exceeded limit): $log_file" >> "$log_file" 2>/dev/null || true
      ) 9>"${log_file}.truncate.lock"
    fi
  fi

  echo "$log_line" >> "$log_file" 2>/dev/null || true
}
