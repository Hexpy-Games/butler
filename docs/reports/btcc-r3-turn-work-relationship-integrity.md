# BTCC R3 turn/work relationship integrity — whole-goal evidence

Status: Task5 validation report. The Sandy correction is a separate audited operation documented in [the redacted correction report](btcc-r3-sandy-correction-draft.md). No Sandy session or Work was used by the Task5 smoke. No commit is created by this Task5 turn.

## Authority and runtime trace

| Boundary | Canonical implementation | Evidence in this validation |
| --- | --- | --- |
| App ingress | `packages/butler-agent/src/gateways/app/interface/server/routes/session-feed-routes.ts` (`POST /messages`) | Isolated live App smoke used this route; each response returned durable `execution_controls` and `execution_model`. |
| Turn admission/execution | `packages/butler-agent/src/gateways/app/domain/sessions/user-message-turn-store.ts` → `packages/butler-agent/src/agent/btcc/turn/turn.ts` | Two isolated App chats created and delivered nine GLM Turns in total (five initial-smoke Turns plus four completion/capture re-smoke Turns). |
| Guided agent/model rounds | `packages/butler-agent/src/agent/btcc/agent-loop/guided-turn-agent.ts` and `guided-tool-call-execution.ts` | Deterministic E2E and live progress rows show model rounds, explicit relation calls, and ordinary tool calls through one executor. |
| Journal/effects | `packages/butler-agent/src/agent/adapters/btcc/sqlite/` and guided journal/effect stores | Focused restart/replay tests preserve completed records and fence started mutations. |
| Relationship authority | `packages/butler-agent/src/agent/btcc/work/work.ts`, `durable-work-tool-execution.ts`, SQLite durable Work store | Only `start_work`/`continue_work` bind Turns; ordinary reads never bind a candidate. |
| Closeout | `guided-turn-closeout.ts` plus `record_work_disposition` in the Work service | Completed/open status is set by disposition; optional Review/Validation remains non-authoritative. |
| Projection/fallback | `packages/butler-agent/src/agent/btcc/projection/`, `guided-operational-facts.ts`, `guided-operational-report.ts` | Current-Turn provenance and fail-closed candidate isolation are exercised by focused tests and the exhaustion path. |
| Delivery/replay | App session message projection and Turn delivery persistence | All deterministic and live smoke Turns ended in canonical `delivered` state; replay tests preserve delivery exactly once. |

The governing rule is durable relation/effect/receipt truth, not a mandatory lifecycle phase. Ordinary activity is observational. Work status is not inferred from a Review, Validation, UI phase, or stale candidate.

## Task5 source changes

- Extracted recorded journal replay, relation-repair replay, prior-result backfill selection, and replay failure fencing into cohesive `guided-recorded-tool-replay.ts`. The public production entrypoint remains `createGuidedToolCallExecutor`; its orchestrator is now 285 lines and `lint:btcc-shape` passes.
- Updated `tests/unit/btcc-r3-validation-context.test.ts` to assert the current optional, non-phase stage wording and reject a required-stage gate.
- Added `whole-goal sequence preserves explicit relation across restart and exhaustion` to `tests/unit/btcc-guided-turn-agent.test.ts`. It covers monitoring open → restart → explicit continuation/completed disposition → restart → ordinary read before unrelated capture selection → model exhaustion fallback with no stale Work/ID → restart → explicit capture continuation/open disposition.
- Extracted the recorded replay domain behind a narrow execution port so the journal replayer has one-way dependencies and no broad caller-contract type cycle.
- Removed operator-specific home-path literals from the audited Sandy correction contract, fixtures, and reports while preserving canonical path resolution from the runtime home. The correction command CLI-reference entry and the native purge `docs/reports` allowance are Task4 integration-debt closures after the correction phases, not new Task5 lifecycle behavior.

## Deterministic whole-goal evidence

Command:

```text
bun test tests/unit/btcc-guided-turn-agent.test.ts tests/unit/btcc-r3-validation-context.test.ts
```

Result: 66 passed, 0 failed. The new whole-goal test passed with 14 assertions. It uses a temporary SQLite fixture, closes/reopens the stores between semantic Turns, and never contacts a provider.

The deterministic sequence proves:

1. monitoring Work is explicitly started and left open;
2. a later Turn explicitly continues the exact Work and records completed disposition;
3. an unrelated Turn performs an ordinary read before `start_work`, then provider exhaustion produces deterministic fallback text without monitoring summary or internal Work ID;
4. a restarted process explicitly continues the capture Work and records truthful open disposition.

The existing focused suite also covers Stop, typed effects/receipts, legacy replay, same-Turn freshness invalidation, fallback field provenance/redaction, no extra report-model round, and restart/replay behavior.

## Isolated live GLM smoke

The live App gateway at `127.0.0.1:18765` was healthy. `/model-catalog` showed registered, runtime-supported `zai/glm-5.2` with `high` reasoning; credential material was not read or printed. A new chat session was created solely for this smoke:

```text
session: -task5-glm-1786200459-
model: zai/glm-5.2
reasoning: high
access: read_only
fallback: disabled
```

Five delivered Turns were sent through the App `/messages` route (the fifth is a deliberate extra Turn because the first capture request correctly refused to invent an ambiguous Work):

- `turn-9057d75c-4247-4f0a-b57a-837702e2d480`: `start_work` monitoring → `open` disposition.
- `turn-68b1156e-285b-4f0d-9f97-bea330916ecd`: exact `continue_work` → truthful `open` disposition.
- `turn-2fc1dde2-af55-4940-8626-aea73dd4eeba`: unrelated capture-themed read-only inspection; ordinary `grep_files` activity occurred before any relation, and the model declined to create a Work because the target was ambiguous.
- `turn-dc697b25-52c5-46ea-a2ee-3f04ffdebbe8`: after an explicit target, `start_work` opened a new capture Work and recorded `open` disposition.
- `turn-9e538395-fa75-4aa0-8725-cad61a714451`: exact capture `continue_work`, four read-only file inspections, and truthful `open` disposition.

Every Turn reported `execution_controls.model_ref=zai/glm-5.2`, `execution_controls.reasoning_effort=high`, `execution_model.requested_model_ref=zai/glm-5.2`, `adapter_effective_model_ref=zai/glm-5.2`, and `provider_reported_model_ref=zai/glm-5.2`. Every Turn was `delivered`, with `access_mode=read_only`, no model fallback, and no external write/network/command operation. The first capture refusal is recorded as model variance, not papered over; the deterministic mock is the lifecycle acceptance authority.

### Completion and capture re-smoke after review

To close the live-smoke lifecycle gap, a second isolated App chat `task5-glm-completion` was created through the same `/messages` ingress. All four Turns were requested as `zai/glm-5.2`, reasoning `high`, `access_mode=read_only`, `plan_mode=false`; each persisted the same requested/effective/provider model identity and `model_fallback.enabled=false`.

- `turn-748485e3-c29f-4839-bd45-acad41280957` explicitly called `start_work` and recorded monitoring Work `guided-work-acc3237a6cb33b5021d7652db270b13a6c976e5ecae8fb823c41ae7b08e9783c` as `open`.
- `turn-179270c3-eab0-41d7-a228-c728f4c28da3` called `continue_work` for that exact Work and then durably recorded disposition revision 2 as `completed`; the final Work status is `completed`. The model made transient invalid disposition attempts before the successful canonical write; no partial state was accepted.
- `turn-ee1c649e-8c1d-46d7-9ba7-6b694f746b8d` performed an ordinary `read_file` of `README.md` first, then called `start_work` for new capture Work `guided-work-ea73e9a21d906d19d98a6db51f316e7701ec53d033ebeb8d8e032ba865201634`, leaving it `open`. The completed monitoring Work remained unchanged.
- `turn-85450237-2093-4cd6-95f4-13e4ec022052` called `continue_work` for the exact capture Work and recorded disposition revision 2 as `open`; no new Work was created and no unfinished check was claimed as complete.

Read-only canonical-store verification after delivery showed exactly two Works in this smoke session: monitoring `completed` with two binding revisions (start and continuation), and capture `open` with two binding revisions (start and continuation). No external file write, network, command, or Sandy-session operation occurred.

## Task4 live evidence carried forward

The audited Sandy correction is complete and separately reported in [btcc-r3-sandy-correction-draft.md](btcc-r3-sandy-correction-draft.md). The Task4 report records the exact live owner-stop manifest, before/after digests, 317 selected journal rows, 2+128 and 2+181 relationship/result counts, monitoring rev10 completed disposition, capture open hardening action, product-reader reopen, replay/idempotency, backup/rollback, and `PRAGMA integrity_check=ok`. Task5 did not mutate the Sandy session, its Works/transcript, or the Sandy repository.

## Phase commits and working tree

The validated pre-existing phases are `de0a3c6e` (explicit relations), `391ca480` (atomic disposition), `87b55cfa` (operational fallback isolation), `4fb268b5`/`46c528ff`/`83a37f45` (audited Sandy correction and SHM-safe ingress), and `351cc230` (live correction report). The complete current uncommitted tree is listed below; the replay/executor/tests and final Task5 report are the Task5 entries, while the four Sandy files are Task4 integration-debt/report updates carried in this worker turn:

```text
packages/butler-agent/src/agent/btcc/agent-loop/guided-recorded-tool-replay.ts
packages/butler-agent/src/agent/btcc/agent-loop/guided-tool-call-execution.ts
tests/unit/btcc-guided-turn-agent.test.ts
tests/unit/btcc-r3-validation-context.test.ts
docs/reports/btcc-r3-turn-work-relationship-integrity.md
docs/reports/btcc-r3-sandy-correction-draft.md
packages/butler-agent/src/operations/correction/sandy-correction-contracts.ts
tests/unit/native-purge-gate.sh
tests/unit/sandy-correction.test.ts
```

## Validation gates

Completed in this turn:

- focused Guided agent + validation suite: 66 passed;
- repository TypeScript check: `bunx tsc --noEmit --pretty false -p tsconfig.json` passed;
- changed-source ESLint: zero errors (only pre-existing test-file warnings);
- `bun run --silent lint:btcc-shape`: `BTCC source shape passed (4 domains, 202 files)`;
- `git diff --check`: passed.
- `bun run --silent lint`: passed with 25 pre-existing warnings and zero errors;
- `bun run --silent typecheck`: passed;
- `bun run --silent app:ui:build`: passed (Vite emitted only its existing large-chunk warning);
- exact post-fix privacy, CLI-reference, native-purge, and Sandy correction suites: 23 passed, 0 failed;
- the repository-wide `bun run check` was rerun after these fixes and exited 0 (all repository check stages passed).

Any external-service variance is reported above rather than treated as deterministic acceptance.

## Remaining scope and safety

No new mandatory lifecycle phase, projection authorization, heuristic Work binding, or fallback model round was introduced. The live GLM smoke used a new read-only chat and did not touch Sandy. Only isolated smoke-session records were written; no Sandy session/correction data was mutated and no service was shut down by Task5. Repository-wide check, typecheck, lint, shape, diff, and UI build gates are green; the parent retains final whole-goal acceptance and independent review authority.
