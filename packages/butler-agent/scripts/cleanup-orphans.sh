#!/usr/bin/env bash
# cleanup-orphans.sh — Kill stale Butler-owned runtime processes not owned by the native supervisor.
# Run before native services start to ensure a clean slate.
set -euo pipefail

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [cleanup-orphans] $*"
}

log "Starting orphan cleanup"

BUTLER_HOME="${BUTLER_HOME:-$HOME/butler}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
LOCK_DIR="$BUTLER_DATA/locks"
MIN_AGE_SECONDS="${MIN_AGE_SECONDS:-300}"  # Only kill processes older than 5 minutes

SERVICE_PIDS=""
if [ -d "$BUTLER_DATA/state/services" ]; then
  SERVICE_PIDS=$(grep -h '"pid"' "$BUTLER_DATA"/state/services/*.json 2>/dev/null | grep -oE '[0-9]+' || true)
fi

is_native_service_managed() {
  local pid="$1"
  if [ -z "$SERVICE_PIDS" ]; then return 1; fi
  echo "$SERVICE_PIDS" | grep -qw "$pid"
}

parse_etime() {
  # Parse ps etime format [[dd-]hh:]mm:ss into total seconds
  # Handles both Linux and macOS ps output (macOS may use extra padding/spaces)
  local raw="$1"
  # Strip all whitespace (macOS ps may pad with spaces)
  raw=$(echo "$raw" | tr -d '[:space:]')
  # Handle empty/zero input
  if [ -z "$raw" ] || [ "$raw" = "0" ]; then
    echo "0"
    return
  fi
  local days=0 hours=0 mins=0 secs=0
  # Extract days if present (dd-...)
  if [[ "$raw" == *-* ]]; then
    days="${raw%%-*}"
    raw="${raw#*-}"
  fi
  # Split remaining by ':'
  IFS=':' read -ra parts <<< "$raw"
  case ${#parts[@]} in
    3) hours="${parts[0]}"; mins="${parts[1]}"; secs="${parts[2]}" ;;
    2) mins="${parts[0]}"; secs="${parts[1]}" ;;
    1) secs="${parts[0]}" ;;
  esac
  # Force base-10 (10#) to prevent bash interpreting "08"/"09" as invalid octal
  echo $(( 10#$days * 86400 + 10#$hours * 3600 + 10#$mins * 60 + 10#$secs ))
}

# Detect OS for platform-specific ps behavior
IS_MACOS=false
if [[ "$(uname -s)" == "Darwin" ]]; then
  IS_MACOS=true
fi

is_old_enough() {
  local pid="$1"
  local raw_etime
  raw_etime=$(ps -o etime= -p "$pid" 2>/dev/null || echo "0")
  local elapsed
  elapsed=$(parse_etime "$raw_etime")
  [ "${elapsed:-0}" -ge "$MIN_AGE_SECONDS" ]
}

# List processes cross-platform. macOS 'ps aux' output is compatible but
# we define a helper for clarity and future divergence.
list_processes() {
  ps aux 2>/dev/null || true
}

KILLED=0

# 1. Find orphan Butler runtime processes with butler-related paths
while IFS= read -r line; do
  pid=$(echo "$line" | awk '{print $2}')
  [ -z "$pid" ] && continue
  # Never kill ourselves
  [ "$pid" = "$$" ] && continue
  # Skip native-supervisor-managed processes
  is_native_service_managed "$pid" && continue
  # Skip young processes
  is_old_enough "$pid" || continue

  cmd=$(echo "$line" | awk '{for(i=11;i<=NF;i++) printf "%s ", $i; print ""}')
  # Verify process identity: re-check the command matches before kill (PID may have been recycled)
  live_cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
  if ! echo "$live_cmd" | grep -qE 'bun.*(\.butler|butler-home|butler-data|/butler/)'; then
    log "Skipping PID=$pid — process identity changed since scan"
    continue
  fi
  log "Killing orphan Butler runtime process: PID=$pid CMD=$cmd"
  kill -TERM "$pid" 2>/dev/null || true
  KILLED=$((KILLED + 1))
done < <(list_processes | grep -E '[b]un.*(\.butler|butler-home|butler-data|/butler/)' | grep -v "cleanup-orphans" || true)
# Pattern: matches Butler runtime processes with .butler, butler-home, butler-data, or /butler/ in their args.

# 2. Remove stale lock files
if [ -d "$LOCK_DIR" ]; then
  for lockfile in "$LOCK_DIR"/*.lock; do
    [ -f "$lockfile" ] || continue
    lock_pid=$(cat "$lockfile" 2>/dev/null | tr -d '[:space:]')
    if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
      log "Removing stale lock file: $lockfile (PID $lock_pid is dead)"
      rm -f "$lockfile"
    fi
  done
fi

# 3. Remove stale PID files in /tmp
for pidfile in /tmp/butler-*.pid; do
  [ -f "$pidfile" ] || continue
  stale_pid=$(cat "$pidfile" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$stale_pid" ] && ! kill -0 "$stale_pid" 2>/dev/null; then
    log "Removing stale PID file: $pidfile (PID $stale_pid is dead)"
    rm -f "$pidfile"
  fi
done

if [ "$KILLED" -gt 0 ]; then
  log "Cleaned up $KILLED orphan process(es)"
else
  log "No orphan processes found"
fi

log "Orphan cleanup complete"
