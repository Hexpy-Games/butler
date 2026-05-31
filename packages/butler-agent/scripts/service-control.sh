#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUTLER_HOME="${BUTLER_HOME:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
export BUTLER_HOME BUTLER_DATA

# shellcheck source=lib/butler-runtime.sh
source "${SCRIPT_DIR}/lib/butler-runtime.sh"
butler_use_runtime || {
  echo "Butler runtime not available. Re-run install.sh." >&2
  exit 1
}

exec "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/native-service.ts" "$@"

