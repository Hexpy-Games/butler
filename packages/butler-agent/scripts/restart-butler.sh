#!/usr/bin/env bash
# restart-butler.sh — Stop then start butler
set -euo pipefail

# Parse flags
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
  esac
done

export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUTLER_HOME="${BUTLER_HOME:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
CONFIG_RUNTIME=$(jq -r '.system.runtime // empty' "$BUTLER_DATA/butler.config.json" 2>/dev/null || echo "")
BUTLER_RUNTIME_EFFECTIVE="${BUTLER_RUNTIME:-${CONFIG_RUNTIME:-codex-api}}"
NATIVE_MAIN_STATE_FILE="$BUTLER_DATA/state/butler-main-native.json"

if [ "$DRY_RUN" = true ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [restart-butler] DRY-RUN: would restart native Butler services"
  exit 0
fi

# stop-butler.sh sets shutdown flag + native service stop + runtime-specific cleanup.
"$SCRIPT_DIR/stop-butler.sh"

# Wait for the active main-process signal to disappear before starting again.
if [[ "${BUTLER_BUTLER_BOOTSTRAP:-}" = "native" || "$BUTLER_RUNTIME_EFFECTIVE" = "codex-api" ]]; then
  for _ in $(seq 1 10); do
    [ ! -f "$NATIVE_MAIN_STATE_FILE" ] && break
    sleep 1
  done
else
  sleep 3
fi

"$SCRIPT_DIR/service-control.sh" start

# Verify native supervisor actually started the process
sleep 2
if ! "$SCRIPT_DIR/service-control.sh" ps --json | grep -q '"serviceId": "butler-main"'; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [restart-butler] ERROR: native service status did not include butler-main after start" >&2
  exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] [restart-butler] Butler restarted successfully."
