#!/usr/bin/env bash
# review_prompts.sh — prompt templates for v2 review worker
#
# Usage (sourced by review_v2.sh):
#   source "$SCRIPT_DIR/lib/review_prompts.sh"
#   PROMPT="$(build_review_prompt "$TASK_ID" "$TASK_DIR")"

build_review_prompt() {
  local task_id="$1"
  local task_dir="$2"
  local plan_md="$task_dir/plan.md"
  local result_md="$task_dir/result.md"
  local claims_jsonl="$task_dir/claims.jsonl"
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  cat <<PROMPT
You are the review worker for butler. Your job is to verify the primary
worker's result.md claims against reality — filesystem, git, gh, test output —
not just against plan text. If the primary worker hallucinated a file path, a
PR number, or a command output, you must catch it.

Task ID: $task_id
Task directory: $task_dir
Plan file: $plan_md
Result file: $result_md
Claims output: $claims_jsonl

The shell is already cd'd into the primary worker's project path, so relative
paths in result.md resolve correctly.

Proceed in three passes in a single session:

## Pass 1 — Claim extraction

Use Read to load $result_md. Extract every falsifiable claim. For each claim
emit one line of JSON to $claims_jsonl via Bash (append with >>):

  {"id":"c01","type":"<kind>","quote":"<verbatim from result.md>","target":"<path|command|ref>"}

Kinds:
  - file_exists      — result claims a file exists
  - command_output   — result claims a command produced output X
  - code_contains    — result claims file X contains string Y
  - git_ref          — result claims a commit/branch/tag
  - pr_state         — result claims a PR state (merged, open, etc.)
  - test_pass        — result claims N tests passed
  - other            — anything else falsifiable

Do NOT extract vague impressions ("the code is cleaner"). Only extract claims
you can check with Read / Grep / Glob / Bash.

## Pass 2 — Claim verification

For each claim, run the read-only check:

  file_exists      → Read (or Glob) the target. PASS if non-empty; FAIL on ENOENT.
  command_output   → Re-run a read-only equivalent (ls, git log -1, gh pr view --json).
                     Never re-run a mutating command.
  code_contains    → Grep target file for claimed string.
  git_ref          → Bash: git rev-parse / git log --oneline.
  pr_state         → Bash: gh pr view <n> --json state,mergeCommit,baseRefName.
  test_pass        → Read the log/output file, count matches.
  other            → Use best available tool; if no mechanical check exists,
                     verdict = UNVERIFIABLE.

Rewrite $claims_jsonl so each line has verdict + rationale appended:

  {"id":"c01","type":"file_exists","quote":"...","target":"...","verdict":"PASS|FAIL|UNVERIFIABLE","rationale":"<one line>"}

Use Bash (e.g. a small awk/jq pipeline or a rewrite via cat > tmp && mv) to
update the file in place.

## Pass 3 — Criteria rollup + review.md

Read plan criteria from $plan_md (YAML frontmatter 'criteria:' list). For each
criterion, identify which claims support it. Overall verdict = FAIL if ANY
load-bearing claim is FAIL. UNVERIFIABLE does not auto-fail but is listed.

Emit to STDOUT (and ONLY to stdout — no preamble, no trailing prose) EXACTLY
this markdown, including the YAML frontmatter delimiters:

---
task_id: $task_id
verdict: PASS|FAIL|UNVERIFIABLE
reviewed: $ts
claim_counts: { pass: N, fail: N, unverifiable: N }
---

## Claim verification
- ✓ <kind> \`<target>\` — <rationale>
- ✗ <kind> \`<target>\` — <rationale>
- ? <kind> \`<target>\` — <rationale>

## Criteria rollup
- [x] <criterion text> — PASS (claims c01, c03)
- [ ] <criterion text> — FAIL (claim c02 failed)

## Overall: PASS|FAIL|UNVERIFIABLE

Rules:
  - Replace verdict and claim_counts with real numbers.
  - Do NOT paraphrase the worker's original quotes — cite them verbatim in the
    claims.jsonl quote field.
  - If you cannot verify a claim, mark it UNVERIFIABLE, not PASS.
  - If claims.jsonl is empty (nothing falsifiable), verdict = UNVERIFIABLE.
PROMPT
}
