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
