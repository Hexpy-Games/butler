# BTCC Gateway Storage Ownership

## Task 1 — Agent store migration

- Commit: `2206e7fe`
- Added the private pre-readiness migration from legacy App BTCC tables to the separate Agent execution store at `agent-runtime/btcc.sqlite`.
- Preserved the legacy source, published through a temporary fsynced target, validated the explicit manifest and receipt, and failed closed for unknown tables or an unreceipted target.

## Task 2 — Durable protocol cutover

- Commit: `387e571b`
- Extended the existing `NativeInboundQueue` → Native Butler → `DeliveryGuard` transcript → App projector path for content-bearing operation-output chunks, final/model metadata, cancellation acknowledgement, and terminal projection.
- Removed live App reads of Agent operation output, model, final, and cancellation state.

## Task 3 — Single-writer cutover

- Native Butler now migrates and activates the separate Agent BTCC store before readiness, validates the activation marker, and opens production BTCC composition only on the Agent path.
- Native Steward is deterministic queue-only and observes caller-visible completion from the existing delivery transcript. It no longer composes BTCC, opens SQLite, or delivers directly.
- App no longer opens Agent conversation/session/BTCC stores. Agent project, memory, continuity, and briefing paths no longer open or query the App database; bounded Turn context and Agent-owned stores are authoritative.
- Removed `AppBtccStopConsumer`, App live/historical BTCC terminal SQL, historical reconciliation, terminal settlement wake SQL, the App conversation outbox reader, and opposite-store optional dependencies.
- Cancellation uses the typed inbound queue request and transcript acknowledgement/terminal path. App does not synthesize terminal completion while that transcript authority is pending.
- Activation permanently fences automatic selection of split-unaware App-managed runtimes; manual rollback requires restoring a pre-cutover snapshot.

### Validation

- 527 focused affected tests passed, including App protocol compatibility, cancellation, transcript projection, migration, Native Steward, project/workspace context, and restart/replay paths.
- Runtime ownership audit passed: live App and Agent compositions used distinct filesystem device/inode identities; App contained no BTCC tables and Agent contained no App chat tables.
- Reciprocal lock test passed: Agent checkpoint write succeeded while the App database held `BEGIN IMMEDIATE`, and App projection write succeeded while the Agent database held `BEGIN IMMEDIATE`.
- Source-boundary audit passed for App→Agent and Agent→App openers, SQL, direct Steward composition, stop consumer, historical reconciliation, fallback, and second-writer seams.
- Typecheck passed. Lint passed with no errors (repository warnings remain outside this change). `git diff --check` passed.
- BTCC shape reported only two pre-existing line-limit findings: `guided-turn-agent.ts` was 378 lines at the Task 2 commit and is 375 lines after this task; `turn/runtime.ts` remains the unchanged 351 lines. No new shape finding was introduced.
- Windows CI and broad unrelated E2E were not run, per the task policy.

## Remaining work

- Task 4 is validation-only: run the final source/runtime boundary audit, bounded product smoke, and whole-goal review. It must not add product behavior.
