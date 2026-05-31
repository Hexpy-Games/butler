#!/usr/bin/env bash
# review.sh — Review a completed task against its plan criteria
# Usage: review.sh <task_id>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUTLER_HOME="${BUTLER_HOME:-$HOME/butler}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"

exec bash "${SCRIPT_DIR}/review_v2.sh" "$@"
