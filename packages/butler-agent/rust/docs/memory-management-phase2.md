# Phase 2 implementation audit

Owner decisions take precedence over the design: immediate reset, no Undo,
future conversations only; profile content is separate from instructions;
chats and other kinds remain intact. A project reset includes its summary,
conversation projection and instructions, and cannot refresh from unchanged
files/tasks automatically.

## Dormant storage readers after the prerequisite merges

References are relative to `crates/`. These are the remaining production
entry points that can address generation artefacts or legacy stores:

- `butler-memory/src/cognition/generation/read.rs:33` — Serving/building resolution and manifest reader; retired targets refused.
- `butler-memory/src/cognition/generation/read.rs:103` — Only building targets can bind snapshot source storage.
- `butler-memory/src/cognition/generation/cache.rs:237` — Cache source binding; live canonical for serving, snapshot for building.
- `butler-memory/src/cognition/generation/embedding_binding.rs:28` — Active/building manifest reader.
- `butler-memory/src/cognition/generation_vectors/adapter.rs:44` — Serving Lance query through a resolved handle.
- `butler-memory/src/cognition/generation_vectors/adapter.rs:130` — Building Lance candidate query; resolution revalidates authority.
- `butler-memory/src/cognition/registration.rs:283` — Conversation registration source binding.
- `butler-memory/src/cognition/registration.rs:62` — Retires idle pooled SQLite connections; active readers remain pinned.
- `butler-memory/src/cognition/registration/typed.rs:279` — Typed registration source binding.
- `butler-memory/src/cognition/registration/projection.rs:183` — Projection source binding.
- `butler-memory/src/cognition/registration/internal_control.rs:50` — Control source binding.
- `butler-memory/src/cognition/registration/typed_lifecycle.rs:166` — Typed lifecycle descriptor/manifest reader.
- `butler-memory/src/cognition/completion/consumer/process.rs:476` — Completion source binding; vector/typed children revalidate it.
- `butler-memory/src/cognition/memory_recall/query.rs:242` — Recall source binding/hydration.
- `butler-memory/src/cognition/mcp_graph/serving.rs:25` — MCP serving graph reader; no retired-target input.
- `butler-memory/src/cognition/memory_health/serving.rs:24` — Serving graph/manifest health reader.
- `butler-memory/src/cognition/generation/swap.rs:81` — Caller-bound CAS manifest reader; no retired serving authority.
- `butler-memory/src/cognition/generation/swap.rs:216` — Caller-bound SQLite snapshot reader.
- `butler-memory/src/cognition/generation/reset.rs:160` — Reset reads the pinned serving generation.
- `butler-memory/src/cognition/generation/reset/vectors.rs:14` — Reset copies every surviving Lance payload without inference.
- `butler-memory/src/cognition/generation/reset/cache.rs:4` — Reset reads surviving structured hot entries and receipts.
- `butler-memory/src/cognition/project_capsule/source/graph.rs:15` — Legacy project graph; remains protected. Reset projects suppress old rows.
- `butler-memory/src/cognition/legacy/recall/corpus.rs:22` — Legacy graph/hot/files fallback; retained.
- `butler-memory/src/cognition/hot_cache/receipts.rs:18` — Legacy receipt/audit store; retained.
- `butler-memory/src/cognition/hot_cache/legacy_graph.rs:82` — Legacy graph; retained.
- `butler-memory/src/cognition/hot_cache/transcript_index.rs:24` — Legacy transcript index; retained.
- `butler-memory/src/cognition/hot_cache/import.rs:150` — Legacy transcript import; retained.
- `butler-agent/src/host/memory_jobs/transcript_sync.rs:32` — Host legacy transcript source; retained.
- `butler-memory/src/management/inventory.rs:8` — Explicit inventory; not a serving reader.
- `butler-memory/src/management/measurement.rs:11` — Explicit allocation metadata scan; not content serving.
- `butler-memory/src/management/cleanup/plan.rs:5` — Building manifest and reset-intent reference inventory.
- `butler-memory/src/management/cleanup/nested.rs:6` — Detached snapshot/qualification metadata inventory.
- `butler-memory/src/management/cleanup/trash.rs:5` — Leased receipt/reference revalidation and restart recovery.
Building manifests protect their snapshot/generation references. Active
manifest/descriptor references protect all named artefacts, including the
previous-generation pointer. Self-references in retired manifests do not keep
otherwise unreachable directories forever. Unreferenced retired generations
and detached `source-snapshot[-hex]`/`qualification` directories in the serving
root are eligible. Unknown names, links, unreadable manifests, legacy stores
and unresolved dead letters remain protected. No SQLite/Lance compaction runs.

The synced rename receipt precedes moving an artefact into operation trash.
Explicit cleanup reconciles interrupted renames; startup does not delete trash.
Whole retired trees are measured/checked for links again before recursive unlink;
the original empty-directory case still uses `remove_dir` to refuse new content.

## Profile admission and reset

Reset captures immutable canonical message and turn identifiers, without reading
message bodies, into `memory_reset_admissions` in the profile owner's transaction.
An epoch is stored in `memory_reset_epochs`. This avoids wall-clock cutoffs,
mutable scan offsets, transient SQLite rowids and delayed turn completion.
The same transaction clears candidates, stable entries, projection and coverage.
The exclusions are cumulative across resets and survive restart and VACUUM.
Consent, names, extractor settings, instructions and canonical chats are preserved.

The host reader joins the exclusion index before hydrating a message. Discovery
and coverage registration also enforce the exclusion, so pre-reset discovery
cannot register old windows after the transaction. Existing claimed batches
lose their coverage rows and fail nonce validation before committing candidates.
New user messages from later turns remain eligible, including within an old chat.

BTCC storage and writers are unchanged. Catch-up adds only the read-only
`read_recovered_source_ids_page` API, sharing the existing recovered-page
eligibility/order/query, so exclusions are checked before bodies are read. The memory owner uses read-only queries over
existing `conversation_messages.id`, `conversation_turns.id` and the message's
`turn_id`. The snapshot of those identifiers is the admission boundary;
subsequent chat admission remains available while the profile transaction commits.

## Conversation and project reset lifecycle

A leased durable intent captures the operation and selected instruction targets.
The background worker snapshots the shared graph, prunes conversation projection
and computes the surviving typed evidence/node/edge/alias/mention closure. It copies complete
surviving Lance payloads with keys/receipts rebound and preserves surviving hot
blocks. Descriptor CAS commits the new directory, with no previous pointer/Undo.
The identifier snapshot is the admission boundary; subsequent turns are eligible
while staging completes. No turn admission or startup waits for the worker.

Registration checks the serving floor before source hydration; recovered catch-up
advances across suppressed IDs without reading bodies. Valid old conversation
queue notices receive a durable `reset-suppressed` disposition before ack. Typed
notices use their existing owner path. Old handles cannot commit late jobs.
No timers or idle polling were added.

Generation handles/graph connections pin readers. Retirement marks the old reader
set, closes idle pooled connections on a blocking worker, and prevents active
operations from returning old connections to the pool. After active readers drain, the worker renames
the old directory into operation trash, syncs both parents and deletes with
per-entry cancellation/containment checks. A receipt separates logical completion
from reclamation. Startup makes one background recovery pass: incomplete staging
is discarded/repeated, committed CAS is completed without clearing future content,
and unfinished reclamation resumes. Pending reset directories are cleanup-protected.

Project reset replays exact per-handle forget operations through the instruction
owner, stages a project-scoped survivor projection/floor, removes its capsule,
and stores its reset epoch. Daily refresh waits for a new project conversation
projection. Explicit refresh is allowed; a prepared refresh must still match its
captured reset epoch at commit. Legacy project graph rows are not re-read for
reset projects. Other project/global sources and profile stay intact. If instruction
forget has committed but projection replacement fails or is cancelled, its intent
remains preparing so the same operation/restart can finish both owners.

Authenticated App POST routes are `/memory/reset/profile`,
`/memory/reset/chat-memory`, `/memory/reset/projects/{id}`. Requests carry an
operation ID and inventory revision. GET/DELETE `/memory/reset/{operation}` reads
status/requests cancellation. Accepted/final receipts publish `memory.operation`.
Writer revisions invalidate inventory; explicit check measures the new state.
Profile has its own transaction-bound receipt so replay never clears later content.

## Disposable snapshot measurement

A fresh copy of the 2.5 GiB benchmark snapshot was measured under `bench/run-mm2/data`:

- Inventory: 918 ms; cached four-card read: 163 µs.
- Cleanup: 17 ms; newly removable/reclaimed: **0 bytes**.
- Serving generation: 1,907,372,032 allocated bytes, including its source snapshot.
- Referenced source snapshot retained: 130,904,064 allocated bytes.
- Previous descriptor generation retained: 8,192 allocated bytes.
- Four complete ranked recall responses exactly equal before/after, including
  order/evidence/content: 3,113 ms before, 1,843 ms after.
- Refused legacy folder: zero added files. Synthetic interrupted rename:
  4,096 bytes reclaimed after explicit resume, with idempotent receipts.

The snapshot lacks some typed owner files (`typed_inventory_unavailable`); content
was not fabricated. This probe uses lexical/graph recall without an embedding
provider, so it does not measure vector recall. The original snapshot was never
changed and the disposable copy was deleted.


## Verification and limits

Stub/replay E2Es cover profile regression #461, authenticated reset routes, complete
shared-node/typed-alias/edge preservation, project isolation, queued instruction
follow-ups, forced termination during staging, profile owner/receipt-gap recovery,
future conversations and replay without clearing newer content. A reset E2E uses
real cached BGE-M3 embeddings and asserts a nonempty instruction vector projection
survives with its recall. MEM-IDLE asserts zero graph transactions, lease writes
and graph-file writes during its idle window; no timer or idle writer was added.

The only BTCC change is a read-only recovered-identifier page API in butler-turn;
its existing storage schema/writers remain unchanged. No dependencies were added.
The full benchmark reset duration and concurrent reset at owner scale were not
measured. Cross-platform runtime behavior remains for macOS/Windows CI; this host
runs Linux. The disposable benchmark probe does not exercise vector recall.


Final local results (all tests/checks use isolated HOME/BUTLER_DATA):

| Test/check | Result |
| --- | --- |
| Stub E2E targets: cli_surface (1), durable_configuration (1), migration (2), personalization (1), personalization_defaults (4), memory (9), memory_existing (1), memory_hot_cache (1), memory_instructions (1), memory_management (3), memory_reset (3), memory_profile_reset (1), memory_idle (3), memory_wiring (4), memory_wiring_more (7) | 42 distinct tests pass |
| Existing butler-memory library tests | 111 pass |
| Existing butler-turn conversation source reader tests | 2 pass |
| cargo fmt --all --check | Pass |
| clippy --all-targets -D warnings: memory, agent, gateway, turn, runtime, e2e | Pass, Rust 1.91.0, -j 8 |
| cargo run -p butler-source-check -- . | Pass; zero shape, architecture, OS-boundary, test-ratchet and E2E-gate violations |
| bun install --frozen-lockfile --ignore-scripts; bun run check | Pass (Bun 1.3.11) |
| Existing design-system checks | 51 pass; 2 pre-existing skips |
| Licence generation/check/disclosure | Pass; no new dependency/licence, no fingerprint-refresh commit |

The final nonempty-vector reset test takes 14.44 s and the three reset scenarios
6.78 s together, including harness/service lifecycle work. These are fixture-run
times rather than reset latency measurements. MEM-IDLE's 60 s window has zero graph
commits and lease commits and unchanged graph/WAL/lock files. Earlier failures
were corrected at their causes: retained idle graph-pool pins, missing local asset
configuration, prompt-section extraction of serialization/separator bytes, and
an existing vector wait placed before its recall trigger. No timeout/budget was
raised and no failing assertion or scenario was skipped.
