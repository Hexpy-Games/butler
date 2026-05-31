#!/usr/bin/env bash
BUTLER_HOME="${BUTLER_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"
export BUTLER_HOME BUTLER_DATA
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/butler-runtime.sh
source "${SCRIPT_DIR}/lib/butler-runtime.sh"
butler_use_runtime || { echo "Butler runtime not available. Re-run install.sh." >&2; exit 1; }
"$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/src/agent/cognition/memory/scripts/embed-server.ts"
