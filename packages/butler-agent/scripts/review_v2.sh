#!/usr/bin/env bash
# review_v2.sh — native claim-verification reviewer.
# Usage: review_v2.sh <task_id>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUTLER_HOME="${BUTLER_HOME:-$HOME/butler}"
BUTLER_DATA="${BUTLER_DATA:-$HOME/.butler}"

# shellcheck source=lib/butler-runtime.sh
source "${SCRIPT_DIR}/lib/butler-runtime.sh"
butler_use_runtime || { echo "Butler runtime not available. Re-run install.sh." >&2; exit 1; }

if [ -f "${BUTLER_HOME}/packages/butler-agent/scripts/butler-log.sh" ]; then
  source "${BUTLER_HOME}/packages/butler-agent/scripts/butler-log.sh"
elif [ -f "${SCRIPT_DIR}/butler-log.sh" ]; then
  source "${SCRIPT_DIR}/butler-log.sh"
else
  butler_log() { :; }
fi

source "${SCRIPT_DIR}/lib/review_prompts.sh"

TASK_ID="${1:-}"
if [[ -z "$TASK_ID" ]]; then
  echo "Usage: review_v2.sh <task_id>" >&2
  exit 1
fi

TASK_DIR="$BUTLER_DATA/tasks/$TASK_ID"

if [[ ! -d "$TASK_DIR" ]]; then
  echo "Error: task directory not found: $TASK_DIR" >&2
  exit 1
fi

if [[ ! -f "$TASK_DIR/plan.md" ]]; then
  echo "Error: plan.md not found in $TASK_DIR" >&2
  exit 1
fi

if [[ ! -f "$TASK_DIR/result.md" ]]; then
  echo "Error: result.md not found in $TASK_DIR — nothing to review" >&2
  echo "REVIEW_FAILED" > "$TASK_DIR/status"
  butler_log tasks ERROR "review_v2_failed: id=$TASK_ID reason=missing_result.md"
  exit 1
fi

# REVIEWING state — visible to butler polling
echo "REVIEWING" > "$TASK_DIR/status"
butler_log tasks INFO "review_v2_started: id=$TASK_ID"

# Seed empty claims.jsonl so reviewer can append
: > "$TASK_DIR/claims.jsonl"

# Project cwd — reviewer must see the same relative paths the primary did.
PROJECT_PATH="$(sed -n 's/^project: *//p' "$TASK_DIR/plan.md" | head -1)"
PROJECT_PATH="${PROJECT_PATH:-$HOME}"
CONFIG_RUNTIME=$(jq -r '.system.runtime // empty' "$BUTLER_DATA/butler.config.json" 2>/dev/null || echo "")
BUTLER_RUNTIME_EFFECTIVE="${BUTLER_RUNTIME:-${CONFIG_RUNTIME:-codex-api}}"

# Reviewer model — native-primary default, overridable via plan review_model:
REVIEW_MODEL="$(sed -n 's/^review_model: *//p' "$TASK_DIR/plan.md" | head -1)"
REVIEW_MODEL="${REVIEW_MODEL:-openai/gpt-5.4}"

PROMPT="$(build_review_prompt "$TASK_ID" "$TASK_DIR")"

cd "$PROJECT_PATH" 2>/dev/null || cd "$HOME"

EXIT_CODE=0
printf '%s' "$PROMPT" | \
  BUTLER_WORKER=1 \
  BUTLER_ROLE=reviewer \
  "$BUTLER_BUN" run "$BUTLER_HOME/packages/butler-agent/scripts/run-tool-prompt.ts" \
    --project-path "$PROJECT_PATH" \
    --model "$REVIEW_MODEL" \
    > "$TASK_DIR/review.md" 2>"$TASK_DIR/review_log.txt" || EXIT_CODE=$?

if [[ $EXIT_CODE -ne 0 ]]; then
  echo "REVIEW_FAILED" > "$TASK_DIR/status"
  butler_log tasks ERROR "review_v2_failed: id=$TASK_ID reason=reviewer_exit_code=$EXIT_CODE"
  echo "Error: reviewer process failed with exit code $EXIT_CODE" >&2
  exit 1
fi

if grep -q "^verdict: PASS" "$TASK_DIR/review.md"; then
  echo "REVIEWED" > "$TASK_DIR/status"
  butler_log tasks INFO "review_v2_completed: id=$TASK_ID verdict=PASS"
elif grep -q "^verdict: FAIL" "$TASK_DIR/review.md"; then
  echo "REVIEW_FAILED" > "$TASK_DIR/status"
  butler_log tasks INFO "review_v2_completed: id=$TASK_ID verdict=FAIL"
elif grep -q "^verdict: UNVERIFIABLE" "$TASK_DIR/review.md"; then
  # UNVERIFIABLE is treated as REVIEW_FAILED for butler's presentation layer —
  # principal still decides. The review.md retains the UNVERIFIABLE verdict.
  echo "REVIEW_FAILED" > "$TASK_DIR/status"
  butler_log tasks INFO "review_v2_completed: id=$TASK_ID verdict=UNVERIFIABLE"
else
  echo "REVIEW_FAILED" > "$TASK_DIR/status"
  butler_log tasks WARN "review_v2_completed: id=$TASK_ID verdict=UNKNOWN (could not parse)"
fi

cat "$TASK_DIR/review.md"
exit 0
