# Developer log capture rewire — spec phase report

Branch: `fix/developer-log-capture`
Worktree: `/Users/yeonwoo/butler-log-fix`

## Problem

Developer logs stopped being written after 2026-07-24/27. Commit `90dea7f4`
(refactor(btcc): remove retired turn owners) deleted the gateway session-actor
layer, which contained the only callers of
`DeveloperLogStore.appendModelTurn` / `appendModelTurnError`. Both store
methods are now dead code; the read path (`/developer-logs`, Settings > Logs)
is healthy and untouched.

Governing spec:
`project-ledger/projects/butler/specs/spec-app-developer-log-viewer.md`
(Butler Project Ledger, outside the repo git history).

## Spec decisions (phase 1)

1. **Ownership** — capture moves into the BTCC Turn runtime
   (`packages/butler-agent/src/agent/btcc/turn/runtime.ts`,
   `runAgentAndCommit`) via an injected diagnostics port (optional
   `TurnRuntimeDependencies` member with noop default, mirroring the existing
   `memoryAttribution` port). Composition root:
   `createProductionBtccComposition`, wired from `native-butler.ts`. The
   retired session-actor path must not be reintroduced.
2. **Gating** — injectable `developerDiagnosticsEnabled?: () => boolean`;
   default fallback `readDeveloperDiagnosticsEnabled({ dbPath: <butlerData>/app-server/butler-client.sqlite })`
   (the `AppSettingsPersistence` database). Checked per capture call, so
   toggling developer mode takes effect next turn without restart. Disabled →
   no entries, no file creation, no settings reads beyond the gate.
3. **Recovered old semantics** (from `90dea7f4^` session-actor/lifecycle):
   - success turn → one `model_turn` entry after the model runtime returns;
   - failed turn → exactly one `model_turn_error` entry and NO normal entry;
     every throwing path was captured unconditionally (aborts, recoverable
     continuation failures included);
   - wrapper swallowed all capture errors ("developer diagnostics must never
     affect the user turn").
4. **BTCC mapping decisions**:
   - exception escaping agent-loop execution → `model_turn_error`;
   - agent-loop error converted into an operational-failure delivered result →
     also `model_turn_error` (parity: pre-cutover these threw out of the
     runtime), no `model_turn` companion;
   - user stop/cancel via the stop path without a model-execution error → no
     entry (new lifecycle does not throw there);
   - replay admissions / `already_delivered` / terminal short-circuits append
     nothing (idempotency).
5. **Persistence unchanged** — JSONL at
   `<butlerData>/app/developer-logs/model-turns.jsonl`, schema
   `butler.developer-log.v1`, newest-500 retention, redaction/file-mode
   guarantees all flow through `DeveloperLogStore` (direct writes forbidden).
6. **Validation shape** — unit tests over real store + port wiring
   (success/error/gate-off/fail-open/idempotency), integration through the
   turn facade writing real JSONL, and restoration of
   `tests/e2e/developer-log-viewer-live-e2e.ts` against the BTCC stack.
7. **Read path** — declared out of scope; transcript replay validation item
   retained in spec as read-path coverage.

## Completeness review

Dimensions checked: ownership, state machine, persistence, UX, failure
semantics, platform, security/privacy, validation. Gaps found and closed in
the same edit pass:

- gate source was unspecified → pinned to injectable gate +
  `readDeveloperDiagnosticsEnabled` fallback with concrete dbPath;
- cancellation semantics ambiguous between old/new lifecycles → explicit
  mapping decision recorded;
- converted operational-failure outcomes were unaddressed → pinned to
  `model_turn_error` for pre-cutover parity;
- idempotency under replay was unstated → fresh-executions-only rule added;
- redaction bypass risk on new path → direct-write prohibition added;
- acceptance criterion for at-most-one-entry-per-turn added.

## Validation (docs-only phase)

- `git diff --check` — clean.
- Heavy gates (`bun run check`, unit suites) deferred to the implementation
  phase; rationale: no executable code changed in this phase.

## Implementation phase

Branch: `fix/developer-log-capture` (this commit).

### What changed

1. **Capture port** — new module
   `packages/butler-agent/src/operations/diagnostics/developer-log-turn-capture/`:
   - `contracts.ts`: `TurnDeveloperLogCapturePort` with
     `model_turn` / `model_turn_error` inputs carrying the durable
     `TurnRecord`, agent-loop result / safe runtime failure, and timestamp.
   - `turn-record-capture-adapter.ts`: maps a `TurnRecord` into the
     `StoredSessionBinding` + `InboundEnvelope` view `DeveloperLogStore`
     expects (`storedBindingFromTurnRecord`,
     `inboundEnvelopeFromTurnRecord`). No gateway route object exists in the
     BTCC lifecycle, so route fields persist as `null`; role derives from
     `executionPolicy.role` (steward/butler).
   - `developer-log-turn-capture.ts`:
     `createTurnDeveloperLogCapturePort({ store, gate })` checks the gate per
     capture call (early-return when disabled: no store access, no file or
     directory creation), appends through
     `DeveloperLogStore.appendModelTurn` / `appendModelTurnError` only, and
     swallows every capture error including gate-read failures (fail-open).
     `createDefaultDeveloperDiagnosticsGate(butlerData)` reads
     `diagnostics_enabled` from `<butlerData>/app-server/butler-client.sqlite`
     via the existing `readDeveloperDiagnosticsEnabled`.
2. **Runtime wiring** — `DefaultTurnRuntime.runAgentAndCommit` gained an
   optional `developerLogCapture` dependency (noop default, mirroring the
   `memoryAttribution` port). Success captures one `model_turn` immediately
   after `agent.run` resolves; any throw captures exactly one
   `model_turn_error` (with `safeRuntimeFailure` + `diagnosticDetails`)
   before the existing conversion/rethrow logic, so converted
   operational-failure outcomes produce the error entry with no companion,
   and rethrown exhaustion paths are captured as well. Replay /
   `already_delivered` / stop-path cancellations never reach the capture
   point.
3. **Composition wiring** — `createProductionBtccComposition` accepts an
   injectable `developerDiagnosticsEnabled` gate and passes the port into the
   turn runtime; production callers get the sqlite settings gate by default.
4. **Deduplication** — `replayBinding` now delegates to
   `storedBindingFromTurnRecord`, removing the duplicated binding mapping.

### Tests

New `tests/unit/btcc-developer-log-capture.test.ts` (7 tests, real turn
runtime + real SQLite stores + real `DeveloperLogStore` JSONL):

- success turn appends exactly one `model_turn` entry with request text,
  response text, model ref, session/turn ids;
- converted operational failure appends only one `model_turn_error` and no
  `model_turn` companion while the turn still delivers;
- exhausted provider failure that rethrows appends the error entry with
  `failure_code`;
- disabled gate appends nothing and creates no log file; toggling the gate
  captures on the next fresh turn without restart;
- a throwing store never fails the turn (fail-open through the real port);
- a throwing gate read never fails the turn;
- replay admissions do not duplicate entries.

Restored `tests/e2e/developer-log-viewer-live-e2e.ts` against the BTCC stack:
live model round through `createProviderModelRoundPort`, App queue → BTCC
dispatch, gated `/developer-logs` API check (403 → PATCH settings → 200),
on-disk JSONL entry assertions, secret redaction assertion.

### Validation results

- Targeted: `bun test tests/unit/btcc-developer-log-capture.test.ts` — 7 pass.
- Regression spot-checks: guided-turn runtime + facade suites — pass.
- Full unit sweep: 2995 pass; 14 failures all pre-existing on this branch
  (verified identical under `git stash`; unrelated to capture rewiring).
- `bun run lint` — clean. `bun run typecheck` — clean.
  `bun run lint:btcc-shape` — clean. `git diff --check` — clean.
- `bash tests/unit/managed-bun-runtime.test.sh` and
  `bash tests/unit/native-purge-gate.sh` — pass.
- `bun run check` cannot complete on this branch: its fast-unit stage hits
  the same 14 pre-existing failures. Residual risk is limited to those
  pre-existing areas; no new failures were introduced by this change.

### Review findings fixed

- Merged duplicated `provider-errors` imports in `runtime.ts`.
- Moved the gate check inside the wrapper's swallow boundary so a throwing
  gate read can never break the turn.
- Fail-open test now drives a throwing store through the real port factory
  instead of injecting a raw throwing port (the swallow contract belongs to
  the wrapper).

### Remaining risks

- The live e2e requires real GPT-5.6 Sol credentials
  (`BUTLER_LIVE_SOURCE_BUTLER_DATA`) and was not executed in this
  environment; it was validated for syntax/imports and mirrors the passing
  unit integration shape.
- Success entries record structured route/work-status metadata in
  `response.raw`; raw provider payloads are not available at the BTCC
  runtime boundary (spec-permitted null/neutral payload).

