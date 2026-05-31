---
name: save-feedback
description: Save an explicit feedback rule to butler's durable memory ($BUTLER_DATA/memory/rules/feedback/).
user-invocable: true
applicability: Use when the model decides the user explicitly wants a durable rule or preference saved for future Butler behavior.
allowed-tools: update_explicit_memory
dispatch: none
review: none
reporting: Confirm only the durable rule update that was saved.
---

<!--
Mechanism: Inline skill — runs directly in the butler session, no worker dispatch.
Writes a frontmatter markdown file under $BUTLER_DATA/memory/rules/feedback/ and appends
a pointer to $BUTLER_DATA/memory/rules/feedback/INDEX.md and, if the feedback category is
not yet listed, to $BUTLER_DATA/memory/rules/INDEX.md.
-->

## Trigger phrases

Invoke this skill when the user says:
- `/save-feedback <text>`
- 이거 기억해 (only when context implies a behavioral rule, not a casual question)
- 피드백 저장
- 다음엔 이렇게 해
- 앞으로는 ~
- 기억해 둬
- 룰 추가해

## Explicit Save Request

Use this skill only after the model has decided the user explicitly wants a
durable rule or preference saved.

- If the user has not supplied actionable content, ask what exact rule or
  preference should be saved.
- If the user is only asking whether Butler remembers something, do not save;
  answer or inspect memory with the appropriate memory tools.

## Instructions

**Step 1 — Collect feedback text**
- If `args` is non-empty, use it as the feedback content.
- If `args` is empty, ask: "피드백 내용이 뭐야? Rule, Why, How to apply 로 나눠서 알려줘도 되고, 한 줄로 써줘도 돼."

**Step 2 — Parse content and generate slug**
Extract or infer:
- `rule`: The core rule (first sentence / main instruction).
- `why`: Reason or context. Default: `"Principal's explicit preference."`
- `how_to_apply`: When/where to apply. Default: `"Apply in all future interactions."`
- `name`: Short human-readable title (≤ 8 words).
- `description`: One-line summary for the index (≤ 120 chars).
- `slug`: Generate using the following algorithm:
  1. Start with `name`, convert to lowercase.
  2. Replace all whitespace with hyphens.
  3. Strip all characters that are not ASCII alphanumeric or hyphens (`[^a-z0-9-]`).
  4. Collapse consecutive hyphens into one; strip leading/trailing hyphens.
  5. If the result is empty (e.g., name was all Korean/non-ASCII), fall back to:
     `feedback-<first8hex>` where `<first8hex>` is the first 8 hex characters of the
     SHA-256 of the feedback text (compute mentally or use a stable prefix derived from
     the first few ASCII words in the feedback body). If no SHA-256 is computable inline,
     use `feedback-<YYYYMMDD-HHMM>` from the current timestamp.
  - Example (ASCII): `"No flattery in responses"` → `no-flattery-in-responses`
  - Example (Korean): `"합니다체 전용"` → `feedback-20260419-1530` (timestamp fallback)

**Step 3 — Write feedback file**
Create `$BUTLER_DATA/memory/rules/feedback/<slug>.md`:

```markdown
---
name: <name>
description: <description>
type: feedback
---

<rule>

**Why:** <why>

**How to apply:** <how_to_apply>
```

Use the Write or Edit tool to create the file. Never overwrite an existing file — if `<slug>.md` already exists, append a numeric suffix (`-2`, `-3`, …).

**Step 4 — Update feedback INDEX**
Append to `$BUTLER_DATA/memory/rules/feedback/INDEX.md` (create the file if it does not exist):
```
- [<name>](<slug>.md) — <description>
```

**Duplicate prevention**: Before appending, read the current contents of `feedback/INDEX.md`. If any existing line already contains `(<slug>.md)`, skip the append entirely — the pointer already exists. This prevents duplicate entries when the same slug is saved more than once (e.g., after a failed run that partially succeeded).

**Step 5 — Update top-level rules INDEX (idempotent)**
Read `$BUTLER_DATA/memory/rules/INDEX.md`.
- If a line already contains `feedback/INDEX.md` or `(feedback/` → skip (category already registered).
- If no such line exists → append exactly one line:
  ```
  - [Feedback Rules](feedback/INDEX.md) — Learned feedback rules from principal interactions
  ```
This check is idempotent: run it on every save, but only append once.

**Step 6 — Transactional order and error handling**
Execute steps in strict order:

1. **Write feedback file** (`$BUTLER_DATA/memory/rules/feedback/<slug>.md`) — Step 3.
2. **Update feedback INDEX** (`$BUTLER_DATA/memory/rules/feedback/INDEX.md`) — Step 4.
3. **Update top-level rules INDEX if needed** (`$BUTLER_DATA/memory/rules/INDEX.md`) — Step 5.

If step 2 fails after step 1 succeeded: emit a warning —
> ⚠️ 피드백 파일은 저장됐지만 feedback/INDEX.md 업데이트 실패. 수동으로 `- [<name>](<slug>.md) — <description>` 줄을 추가하세요.

If step 3 fails after steps 1–2 succeeded: emit a warning —
> ⚠️ feedback/INDEX.md 업데이트는 완료, 하지만 $BUTLER_DATA/memory/rules/INDEX.md 업데이트 실패. 파일은 `feedback/<slug>.md`에 존재합니다.

**Do not delete the feedback file on downstream failure.** The file is the source of truth;
index pointers can be repaired by re-running the relevant append. Recovery: read
`$BUTLER_DATA/memory/rules/feedback/` directory and rebuild INDEX.md from filenames if needed.

**Step 7 — Confirm**
Reply with:
> 피드백 저장 완료 — `feedback/<slug>.md`

---

## Example usage

```
/save-feedback 코드 리뷰 요청 전에 항상 lint 통과 여부 먼저 확인해
```

Butler will create `$BUTLER_DATA/memory/rules/feedback/check-lint-before-review.md` with:
- Rule: 코드 리뷰 요청 전에 항상 lint 통과 여부 먼저 확인해
- Why: Principal's explicit preference.
- How to apply: Apply in all future interactions.

Then append a pointer to `feedback/INDEX.md`, and (if not already present) register the
feedback category in `$BUTLER_DATA/memory/rules/INDEX.md`.
