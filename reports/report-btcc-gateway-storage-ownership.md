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

## Task 4 — Storage ownership validation

- The consolidated approved suite passed 507 tests across 31 files. It covers
  exact migration and interruption recovery, queue restart/replay/dedupe, both
  transcript crash boundaries, operation-output chunks, model identity,
  cancellation, revival, retention, Native Steward queue-only completion, App
  protocol compatibility, and the source/runtime ownership boundaries.
- The opener audit found and removed the final production Agent read of
  `butler-client.sqlite.app_settings`. App, Agent BTCC, Agent conversation, and
  Agent session stores now resolve to distinct writable filesystem identities.
- Reciprocal locking was repeated through the actual `AppServerStore` schema
  and canonical Agent `btcc.sqlite`: either side continued writing while the
  other held `BEGIN IMMEDIATE`.
- Migration now fences the App Gateway lifecycle and the legacy SQLite writer
  through publish and activation, parks active claims in the temporary target,
  validates explicit durable references, preserves valid pre-admission stops,
  and verifies the bounded receipt without mutating the source.
- Cancellation now replays a pending App-owned outbox row through the existing
  idempotent `NativeInboundQueue`, including the crash boundary after queue
  write and before the App `queue_id` update.
- Typecheck passed. Lint passed with zero errors and 24 pre-existing warnings.
  BTCC shape passed (4 domains, 227 files); `guided-turn-agent.ts` and
  `turn/runtime.ts` are each at the 350-line limit after a cohesive final-result
  extraction. `git diff --check` passed.
- The one final bounded product smoke passed: App HTTP message → durable inbound
  queue → Native Butler → delivery transcript → App projection, including the
  projected session title.
- Independent ordinary non-fast Sol high whole-goal review initially found the
  remaining migration, cross-store settings, cancellation, and evidence gaps.
  After failing-first repairs and repeated review, it approved with no P0–P3.
- Windows CI and broad unrelated E2E were not run locally, per policy.

## Result

All SGSO-SC01 through SGSO-SC09 are satisfied through the single public path.
No merge or default-on action is part of this work.
