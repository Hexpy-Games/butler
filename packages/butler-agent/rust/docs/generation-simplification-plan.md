# Generation simplification plan

Design only; owner approval is required before implementation or deletion. Analysis baseline: `53fa0a313` on `codex/generation-simplify`, 2026-10-02. No production source changes, model calls, owner-folder access or data migration were performed.

Keep the vector store and adopt native writes into the existing serving generation. Defer full re-embedding until a future embedding-model change. The reported recall measurement motivating that decision is owner-provided context, not a measurement reproduced by this task.

## Inventory and reachability method

Counts are physical Rust source lines, including comments/blank lines, measured with Python `splitlines()`. Every `.rs` file under `generation/` and `generation_vectors/` is included. Related graph readiness, receipt, claim, stage, repair, schema and cursor modules (including graph apply and the current-vector recall receipt bridge), and every registration module, are included separately; unrelated graph recall/ranking/index implementation is outside the total. Parent module files are counted once. JSON fixtures are excluded. A LIVE file can contain dormant branches: this is a file-level inventory, not a count of executed instructions or removable lines. TEST-ONLY means compiled under a test module; UNREACHABLE means compiled library functionality with no route from the production entry points, even if tests invoke it. Public exports alone do not make a production caller.

All evidence below is relative to `crates/butler-memory/src/cognition/`; `A/` means `crates/butler-agent/src/host/`, both under `packages/butler-agent/rust/`. The standalone `cognition.rs` means the memory crate’s `src/cognition.rs`; bare E2E test names mean `crates/butler-e2e/tests/`. Each evidence cell names a caller/guard or the module's entry and a shared reachability proof. These are baseline line numbers, not promised future locations.

Production roots and negative evidence:

- **Startup:** `A/runtime.rs:91` calls `A/runtime/memory_bootstrap.rs:37` to reserve fresh initialisation; `A/runtime.rs:118` passes it to memory sync. `A/memory_jobs/sync.rs:71,79,82` builds a normal consumer with embeddings and spawns polling; `:150` materialises fresh memory before `:164` polls. Bootstrap checks unsupported legacy data before writes (`A/runtime/memory_bootstrap.rs:31`).
- **Completion:** `completion/consumer/process.rs:243,249` resolves Active and registers conversation sources. Typed processing resolves Active (`completion/consumer/process/typed.rs:46`). Semantic recovery/projection is invoked at `completion/consumer/process.rs:369,372,398`; vector writes bind identity/upsert/complete at `completion/consumer/process/vector.rs:217,231,243`; hot publication calls `generation/cache::advance_at` at `completion/consumer/process/cache.rs:27`.
- **Daily:** `A/runtime.rs:173` supplies the same consumer. `A/memory_jobs/daily.rs:159` runs catch-up, `:227` resolves the active generation for configured consolidation/optimization. `A/memory_jobs/maintain_phase.rs:35,39` catches up/polls. `graph_consolidation.rs:47,66` and `vector_optimize.rs:78` resolve/recheck Active, not candidate generations.
- **Recall/prompt/health:** `A/runtime.rs:217` injects the vector adapter; `memory_recall/service.rs:233` resolves Active; `generation_vectors/adapter.rs:54,90,92` checks compatibility and searches. `prompt/memory.rs:111,162,190` resolves, validates retained entries and rechecks the pointer. `memory_health/serving.rs:29,42,43` resolves, reads cache health and checks for pointer changes.
- **CLI:** `A/cli/command.rs:17,52,99` enumerates/dispatches the native command surface. There is no memory rebuild/activate/rollback/qualify command. Status reads the running service's embedding progress or cached asset status (`A/cli/status_memory.rs:6,15`), not rebuild inspection. The service launch reaches the startup root above.
- **U (unused control surface):** `generation.rs:28,39,43,45,48,51,52,53,54,55` and `cognition.rs:95` export the rebuild/cutover/qualification/repair APIs. Repository-wide symbol searches find exports, definitions, calls within this unused subsystem, and tests, but no caller from the roots above. `cutover::repair_pending` (`generation/cutover.rs:37`) also has no call site. Activation (`generation/cutover/activate.rs:37`) and rollback (`generation/cutover/rollback.rs:121`) are thus not startup recovery. Helpers downstream of those APIs inherit U. This claim is scoped to this repository's executable, not hypothetical external library users.
- **B (building-only branch):** `completion/consumer.rs:114` offers `with_rebuild_target`, but no production caller selects it. Production supplies Active or the default None (`completion/consumer/process.rs:478,479`). Cache reconciliation explicitly requires `MemoryGenerationTarget::Rebuild` (`generation/cache.rs:136`); its inventory/evaluator calls at `:261,285` therefore do not make those helpers live. Shared retained-entry validation at `generation/cache.rs:208`, `prompt/memory.rs:162`, and `generation/cache/health.rs:125` does remain LIVE. A future removal must split these shared methods before deleting their parent modules.

- `generation`: LIVE 3,402, TEST-ONLY 886, UNREACHABLE 7,717.
- `generation_vectors`: LIVE 1,097, TEST-ONLY 0, UNREACHABLE 603.
- `graph`: LIVE 6,087, TEST-ONLY 738, UNREACHABLE 1,740.
- `registration`: LIVE 1,959, TEST-ONLY 2,567, UNREACHABLE 0.
- `generation.rs`: LIVE 62, TEST-ONLY 0, UNREACHABLE 0.
- `generation_vectors.rs`: LIVE 14, TEST-ONLY 0, UNREACHABLE 0.
- `graph.rs`: LIVE 484, TEST-ONLY 0, UNREACHABLE 0.
- `registration.rs`: LIVE 454, TEST-ONLY 0, UNREACHABLE 0.

**Total: LIVE 13,559; TEST-ONLY 4,191; UNREACHABLE 10,060; 27,810 lines across 121 files.**

| Module | Lines | Status | Purpose | Production caller / evidence |
|---|---:|---|---|---|
| `generation.rs` | 62 | LIVE | Generation API exports and module wiring | `cognition.rs:95` |
| `generation/authority.rs` | 40 | LIVE | Recheck serving pointer and writable format | `completion/consumer/process/vector.rs:309` |
| `generation/cache.rs` | 364 | LIVE | Claim, render and publish one hot-cache job | `completion/consumer/process/cache.rs:27` |
| `generation/cache/format.rs` | 412 | LIVE | Parse/render bounded source-backed hot entries | `generation/cache/publication.rs:51` |
| `generation/cache/format/blocks.rs` | 202 | LIVE | Parse hot-cache blocks and metadata | `generation/cache/format.rs:26` |
| `generation/cache/format_pin.rs` | 108 | TEST-ONLY | Format pin or rebuild race/qualification test support | `generation/cache/format_pin.rs:1; generation.rs:60` |
| `generation/cache/health.rs` | 183 | LIVE | Validate physical cache and eviction health | `memory_health/serving.rs:42` |
| `generation/cache/publication.rs` | 207 | LIVE | Publish bytes before committing cache receipt | `generation/cache.rs:219,230` |
| `generation/cache/receipt.rs` | 215 | LIVE | Wire receipts for publication, outcomes and health | `graph/cache_quantum.rs:14` |
| `generation/cutover.rs` | 121 | UNREACHABLE | Repair pending pointer transition; export activate/rollback | `generation/cutover.rs:37; U` |
| `generation/cutover/activate.rs` | 233 | UNREACHABLE | Qualify and activate candidate pointer | `generation/cutover/activate.rs:37; U` |
| `generation/cutover/descriptor.rs` | 330 | UNREACHABLE | Capture, swap and reconcile descriptor/manifest states | `generation/cutover/activate.rs:195; U` |
| `generation/cutover/qualification.rs` | 107 | UNREACHABLE | Revalidate stored cutover acceptance bundle | `generation/cutover/activate.rs:79; U` |
| `generation/cutover/rollback.rs` | 493 | UNREACHABLE | Restore previous pointer with witness checks | `generation/cutover/rollback.rs:121; U` |
| `generation/embedding_binding.rs` | 177 | LIVE | Durably bind first native embedding identity | `completion/consumer/process/vector.rs:217` |
| `generation/format_pin.rs` | 347 | TEST-ONLY | Format pin or rebuild race/qualification test support | `generation/format_pin.rs:1; generation.rs:60` |
| `generation/initialize.rs` | 216 | LIVE | Reserve fresh bootstrap and publish empty generation | `A/runtime/memory_bootstrap.rs:37; A/memory_jobs/sync.rs:150` |
| `generation/initialize/durable.rs` | 51 | LIVE | Private atomic JSON and directory writes | `generation/initialize.rs:113` |
| `generation/initialize/empty.rs` | 174 | LIVE | Fresh eligibility and strict-empty safeguards | `generation/initialize.rs:150` |
| `generation/manifest.rs` | 485 | LIVE | Compatible descriptor/manifest wire types and parsing | `generation/read.rs:243` |
| `generation/qualification.rs` | 134 | UNREACHABLE | Validate required acceptance and performance evidence | `generation/qualification_service.rs:120; U` |
| `generation/qualification/case.rs` | 365 | UNREACHABLE | Check individual recall/source acceptance cases | `generation/qualification.rs:29; U` |
| `generation/qualification/io.rs` | 362 | UNREACHABLE | Load/hash qualification evidence files | `generation/qualification.rs:29; U` |
| `generation/qualification/performance.rs` | 363 | UNREACHABLE | Check latency/contention evidence and sample coverage | `generation/qualification.rs:29; U` |
| `generation/qualification/source.rs` | 355 | UNREACHABLE | Validate evidence source membership and currentness | `generation/qualification/case.rs:289; U` |
| `generation/qualification/source/inventory.rs` | 205 | UNREACHABLE | Decode/hash qualification inventory | `generation/qualification/source.rs:3; U` |
| `generation/qualification/tests.rs` | 85 | TEST-ONLY | Format pin or rebuild race/qualification test support | `generation/qualification/tests.rs:1; generation.rs:60` |
| `generation/qualification/types.rs` | 361 | UNREACHABLE | Qualification report, binding and result contracts | `generation/qualification.rs:1; U` |
| `generation/qualification_service.rs` | 474 | UNREACHABLE | Stage and commit qualified manifest/evidence | `generation/qualification_service.rs:79; U` |
| `generation/qualification_witness.rs` | 385 | UNREACHABLE | Hold live/candidate revision and file witnesses | `generation/qualification_service.rs:99; U` |
| `generation/read.rs` | 276 | LIVE | Resolve pointer, manifest, graph and embedding | `memory_recall/service.rs:233` |
| `generation/rebuild.rs` | 379 | UNREACHABLE | Prepare candidate snapshot, graph and manifest | `generation/rebuild.rs:78; U` |
| `generation/rebuild/build_inventory.rs` | 166 | UNREACHABLE | Read paged inventory and assert candidate registration | `generation/rebuild.rs:20; U` |
| `generation/rebuild/inspect.rs` | 199 | UNREACHABLE | Count candidate projection progress | `generation/rebuild/inspect.rs:62; U` |
| `generation/rebuild/inventory.rs` | 371 | UNREACHABLE | Snapshot canonical and typed source inventory | `generation/rebuild.rs:287; U; B` |
| `generation/rebuild/inventory/typed.rs` | 167 | UNREACHABLE | Inventory task-report and explicit-record snapshots | `generation/rebuild/inventory.rs:29; U` |
| `generation/rebuild/legacy_baseline.rs` | 171 | UNREACHABLE | Register legacy manifest/pointer baseline | `generation/rebuild.rs:98; U` |
| `generation/rebuild/readiness.rs` | 411 | UNREACHABLE | Compute/record whole-candidate readiness | `generation/qualification_service.rs:101; U` |
| `generation/rebuild/readiness/cache.rs` | 138 | UNREACHABLE | Compare complete cache receipts to retained physical entries | `generation/cache.rs:136,285; B` |
| `generation/rebuild/readiness/facts.rs` | 149 | UNREACHABLE | Gather source, vector and cache candidate facts | `generation/rebuild/readiness.rs:1; U` |
| `generation/rebuild/refresh.rs` | 416 | UNREACHABLE | Refresh changed candidate snapshot with delta bookkeeping | `generation/rebuild.rs:27; U` |
| `generation/rebuild/tests.rs` | 314 | TEST-ONLY | Format pin or rebuild race/qualification test support | `generation/rebuild/tests.rs:1; generation.rs:60` |
| `generation/rebuild/typed_snapshot.rs` | 281 | UNREACHABLE | Copy and refresh typed source snapshot files | `generation/rebuild.rs:295; U` |
| `generation/reconcile.rs` | 165 | UNREACHABLE | Reconcile candidate node vector representatives | `generation/reconcile.rs:62; U` |
| `generation/repair_inputs.rs` | 172 | UNREACHABLE | Explicit repair of candidate extraction inputs | `generation.rs:53; U` |
| `generation/retry_failed.rs` | 152 | UNREACHABLE | Operator reset/repair of failed candidate/active jobs | `generation/retry_failed.rs:133; U` |
| `generation/set_extractor.rs` | 92 | UNREACHABLE | Set primary/fallback extractor model policy on candidate | `generation.rs:55; U` |
| `generation/stage.rs` | 108 | LIVE | Writer leases retained across blocking cache work | `generation/cache.rs:88` |
| `generation/tests.rs` | 32 | TEST-ONLY | Format pin or rebuild race/qualification test support | `generation/tests.rs:1; generation.rs:60` |
| `generation/types.rs` | 292 | LIVE | Handle, target and JS/native embedding identities | `generation/read.rs:250` |
| `generation_vectors.rs` | 14 | LIVE | Vector adapter exports and module wiring | `A/runtime/memory_bootstrap.rs:50` |
| `generation_vectors/adapter.rs` | 175 | LIVE | Recall and binding-candidate vector adapter | `A/runtime.rs:217; generation_vectors/adapter.rs:108` |
| `generation_vectors/compatibility.rs` | 86 | LIVE | Compare actual numerical embedding identity to stored domain | `completion/consumer/process/vector.rs:226` |
| `generation_vectors/readiness.rs` | 260 | UNREACHABLE | Verify every completed candidate vector against persisted rows | `generation/rebuild/readiness/facts.rs:1; U` |
| `generation_vectors/representative.rs` | 343 | UNREACHABLE | Prepare reconciled node representative vector rows | `generation/reconcile.rs:62; U` |
| `generation_vectors/rows.rs` | 404 | LIVE | Lance upserts and persisted row receipts | `completion/consumer/process/vector.rs:139,231` |
| `generation_vectors/search.rs` | 432 | LIVE | Search compatible generation vector rows | `generation_vectors/adapter.rs:92` |
| `graph.rs` | 484 | LIVE | Repository and graph stage API wiring | `registration.rs:277` |
| `graph/apply.rs` | 418 | LIVE | Transactional meaning/final apply and attempt settlement | `graph.rs:269; registration/projection/stages/finalize.rs:43` |
| `graph/apply/context.rs` | 75 | LIVE | Update context during graph apply | `graph/apply.rs:3` |
| `graph/apply/edges.rs` | 169 | LIVE | Apply graph edges and evidence under transaction | `graph/apply.rs:4` |
| `graph/apply/nodes.rs` | 183 | LIVE | Apply nodes, mentions, summaries and vector invalidation | `graph/apply.rs:9` |
| `graph/cache_quantum.rs` | 410 | LIVE | Durable cache claims, retries, receipts and entry outcomes | `generation/cache.rs:135,232` |
| `graph/cache_work.rs` | 169 | LIVE | Cache pending index and read-only work probe | `generation/cache.rs:133` |
| `graph/failure.rs` | 213 | LIVE | Nonce-bound semantic failure and disposition persistence | `graph.rs:239; registration/projection.rs:308` |
| `graph/jobs.rs` | 390 | LIVE | Persist stage progress and completion states | `graph.rs:362` |
| `graph/operator_repair.rs` | 51 | UNREACHABLE | Operator policy and pinned-input repair API | `generation/repair_inputs.rs:157; generation/set_extractor.rs:82; U` |
| `graph/operator_repair/policy.rs` | 127 | UNREACHABLE | Write configured extractor primary/fallback policy | `graph/operator_repair.rs:23; U` |
| `graph/operator_repair/repair.rs` | 410 | UNREACHABLE | Repair pinned inputs and store repair receipts | `graph/operator_repair.rs:35; U` |
| `graph/operator_repair/repair/window.rs` | 131 | UNREACHABLE | Validate repair window and reload archived input receipt | `graph/operator_repair/repair.rs:1; U` |
| `graph/operator_repair/request.rs` | 104 | UNREACHABLE | Decode expected candidate repair bindings | `graph/operator_repair/repair.rs:16; U` |
| `graph/probe.rs` | 37 | LIVE | Read-only recoverable window/vector work questions | `completion/consumer/process.rs:369` |
| `graph/progress_adapters.rs` | 68 | LIVE | Progress adapter plus dormant rebuild cursor reader | `graph.rs:362; generation/rebuild/build_inventory.rs:156` |
| `graph/projection.rs` | 310 | LIVE | Semantic claim/input/commit and recovery bookkeeping | `registration/projection.rs:239` |
| `graph/projection/tests.rs` | 138 | TEST-ONLY | Semantic nonce/claim recovery regression tests | `graph/projection.rs:310` |
| `graph/readiness.rs` | 275 | UNREACHABLE | Whole-candidate source lineage/graph evidence | `generation/rebuild/readiness/facts.rs:20; U` |
| `graph/readiness/cache.rs` | 450 | LIVE | Validate retained entries; also candidate requeue/outcome queries | `generation/cache.rs:208; prompt/memory.rs:162; B` |
| `graph/readiness/stages.rs` | 181 | UNREACHABLE | Whole-candidate stage counts and completed receipt rows | `generation/rebuild/readiness/facts.rs:26; generation/cache.rs:136,257; B` |
| `graph/recall.rs` | 336 | LIVE | Pinned graph reader and current-vector receipt bridge | `memory_recall/service.rs:233; graph/recall.rs:43` |
| `graph/recall/vectors.rs` | 281 | LIVE | Reject stale vector matches through graph receipts | `graph/recall.rs:50` |
| `graph/recall/vectors/tests.rs` | 260 | TEST-ONLY | Current-vector receipt/scope regression tests | `graph/recall/vectors.rs:19` |
| `graph/retry_failed.rs` | 351 | UNREACHABLE | Operator failed-stage reset and selected-vector repair | `generation/retry_failed.rs:125,133; U` |
| `graph/schema.rs` | 58 | LIVE | Ensure live graph tables and compatibility schema | `graph.rs:331` |
| `graph/schema/base.rs` | 165 | LIVE | Create graph schema including receipt/attempt tables | `graph/schema.rs:29` |
| `graph/schema/migration.rs` | 83 | LIVE | Add compatible columns/indexes to existing graph | `graph/schema.rs:28,31` |
| `graph/schema/tests.rs` | 86 | TEST-ONLY | Schema format pin against existing fixture | `graph/schema/tests.rs:1` |
| `graph/stage_state.rs` | 157 | LIVE | Parse/write source, semantic, vector and cache job states | `graph/jobs.rs:292` |
| `graph/stages.rs` | 148 | LIVE | Nonce-bound invocation intents, provider answers and saved plans | `registration/projection/stages.rs:83,98` |
| `graph/typed_registration.rs` | 113 | LIVE | Register typed sources and optional rebuild cursor | `registration/typed.rs:1; completion/consumer/process/typed.rs:46` |
| `graph/typed_registration/plan.rs` | 161 | LIVE | Typed job plan and dormant snapshot cursor persistence | `graph/typed_registration.rs:38` |
| `graph/typed_registration/rows.rs` | 293 | LIVE | Insert typed source/chunk graph rows | `graph/typed_registration.rs:71,84` |
| `graph/vector_optimize.rs` | 69 | LIVE | Collect safe removable vector keys from live receipts | `graph.rs:119; vector_optimize.rs:78` |
| `graph/vector_quantum.rs` | 457 | LIVE | Vector claims, intent/outcome flags and receipts | `completion/consumer/process/vector.rs:107,243` |
| `graph/vector_quantum/recovery.rs` | 56 | LIVE | Recover interrupted vector claims safely | `graph/vector_quantum.rs:108` |
| `graph/vector_registration.rs` | 235 | LIVE | Register episode/node vector units after graph apply | `registration/projection/stages/finalize.rs:115` |
| `graph/vector_registration/tests.rs` | 254 | TEST-ONLY | Episode/node vector registration correctness tests | `graph/vector_registration/tests.rs:1` |
| `graph/vector_registration/units.rs` | 268 | LIVE | Persist current episode/node vector work units | `graph/vector_registration.rs:121` |
| `graph/vector_registration/units/nodes.rs` | 315 | LIVE | Choose node representative units and receipt revisions | `graph/vector_registration/units.rs:17` |
| `graph/vector_representative.rs` | 110 | UNREACHABLE | Load node representative evidence for candidate reconciliation | `generation/reconcile.rs:57; U` |
| `registration.rs` | 454 | LIVE | Source registration service and replay/lease ownership | `completion/consumer/process.rs:249` |
| `registration/internal_control.rs` | 119 | LIVE | Retire superseded internal-control source projections | `registration.rs:221` |
| `registration/projection.rs` | 488 | LIVE | Claim and run one semantic window under authority | `completion/consumer/process.rs:398` |
| `registration/projection/notice.rs` | 69 | LIVE | Recheck current canonical/typed source notice | `registration/projection.rs:350` |
| `registration/projection/recovery.rs` | 135 | LIVE | Recover dead semantic owner claims | `completion/consumer/process.rs:372` |
| `registration/projection/stages.rs` | 288 | LIVE | Replay saved stage results and run provider stages | `registration/projection.rs:369` |
| `registration/projection/stages/finalize.rs` | 147 | LIVE | Validate/apply plan and register vector units | `registration/projection/stages.rs:4` |
| `registration/stages.rs` | 124 | LIVE | Lease-bound schema/replay/register steps | `registration.rs:245,249,251` |
| `registration/tests.rs` | 433 | TEST-ONLY | Registration, lifecycle, recall or wire regression tests | `registration/tests.rs:1; registration.rs:454` |
| `registration/tests/cases.rs` | 413 | TEST-ONLY | Registration, lifecycle, recall or wire regression tests | `registration/tests/cases.rs:1; registration.rs:454` |
| `registration/tests/cases/lifecycle.rs` | 92 | TEST-ONLY | Registration, lifecycle, recall or wire regression tests | `registration/tests/cases/lifecycle.rs:1; registration.rs:454` |
| `registration/tests/exact_query_pin.rs` | 63 | TEST-ONLY | Registration, lifecycle, recall or wire regression tests | `registration/tests/exact_query_pin.rs:1; registration.rs:454` |
| `registration/tests/identity_history_pin.rs` | 142 | TEST-ONLY | Registration, lifecycle, recall or wire regression tests | `registration/tests/identity_history_pin.rs:1; registration.rs:454` |
| `registration/tests/semantic.rs` | 367 | TEST-ONLY | Registration, lifecycle, recall or wire regression tests | `registration/tests/semantic.rs:1; registration.rs:454` |
| `registration/tests/semantic/lifecycle.rs` | 253 | TEST-ONLY | Registration, lifecycle, recall or wire regression tests | `registration/tests/semantic/lifecycle.rs:1; registration.rs:454` |
| `registration/tests/semantic/provider.rs` | 355 | TEST-ONLY | Registration, lifecycle, recall or wire regression tests | `registration/tests/semantic/provider.rs:1; registration.rs:454` |
| `registration/tests/semantic/provider/lifecycle.rs` | 74 | TEST-ONLY | Registration, lifecycle, recall or wire regression tests | `registration/tests/semantic/provider/lifecycle.rs:1; registration.rs:454` |
| `registration/tests/semantic/provider/recall.rs` | 180 | TEST-ONLY | Registration, lifecycle, recall or wire regression tests | `registration/tests/semantic/provider/recall.rs:1; registration.rs:454` |
| `registration/tests/semantic/ranked.rs` | 195 | TEST-ONLY | Registration, lifecycle, recall or wire regression tests | `registration/tests/semantic/ranked.rs:1; registration.rs:454` |
| `registration/typed.rs` | 298 | LIVE | Register current or snapshot typed source | `completion/consumer/process/typed.rs:85` |
| `registration/typed_lifecycle.rs` | 197 | LIVE | Consume forgotten/superseded typed-source notices | `completion/consumer/process/typed.rs:69` |
| `registration/types.rs` | 94 | LIVE | Source notices, registration inputs and outcomes | `completion/consumer/process.rs:249` |

## The generation contract production needs today

A generation is a serving storage directory and an embedding compatibility domain. Production needs neither a candidate lifecycle nor a certificate that a historical full rebuild passed acceptance. Keep one descriptor pointing at an already usable directory; graph/vector/cache jobs remain independently durable.

Minimal API (retain existing names through an implementation stage to avoid touching recall or host work):

- `active_memory_descriptor_exists(data, paths)` for the existing legacy daily-job fallback; `resolve_active_generation(data, paths) -> MemoryGenerationHandle` for reads.
- `resolve_generation(data, paths, Active { expected_generation })` for pinned operations. Ultimately the target can become an expected-id token, but retain the Active variant until all production callers can be adjusted inside memory. Handle fields: generation id, root, graph path, embedding and live source root. Candidate snapshot fields can disappear after dormant branches do.
- `assert_mutation_authority(data, paths, expected, handle)` under the existing write lease: freshly reread the pointer, reject changed id, require Running and V2. Keep path/data-authority and lease checks separately; an immutable read handle never grants write permission (`generation/authority.rs:19`; `generation_vectors/rows.rs:116`). Do not impose new state/qualification requirements on existing active data.
- `prepare_fresh_memory_generation(...) -> Option<FreshMemoryGeneration>` and `FreshMemoryGeneration::initialize()`: preserve reservation before producers, deferred materialisation before consumer catch-up, private graph creation and durable descriptor-last publication (`generation/initialize.rs:137,182,197`). Keep partial/nonfresh refusal and unsupported legacy no-write behavior. The strict exported `initialize_empty_memory_generation` at `generation/initialize.rs:27` has no production caller; its useful safeguards must survive in bootstrap tests, not as a second public startup route.
- `bind_native_embedding_identity(...)` for the first native write to an explicitly unbound eligible generation, with atomic manifest preservation (`generation/embedding_binding.rs:28,80,140`). Do not replace a bound owner manifest to adopt native writes.
- Embedding identity validation plus `compatibility::preflight` and `compatibility::query_identity` (`generation_vectors/compatibility.rs:10,46`), used by both writes and queries. Keep JS/native compatibility, stored version as row compatibility domain, and actual tensor/tokenizer checks. Runtime provenance is not itself numerical incompatibility (`completion/consumer/process/vector.rs:112,226`). A model/tokenizer/profile mismatch must fail, never silently relabel stored vectors.

Cache publication/health and `GenerationVectorAdapter` remain live memory services, not generation-management API. Do not rewrite their storage, recall candidates, ranking, alias postings or WAL behavior to achieve this simplification.

Manifest facts actually consumed:

| Facts | Live use / evidence | Simplification rule |
|---|---|---|
| Descriptor schema, generationId, projectionMode | Read pointer (`generation/read.rs:205,213,216`); mutation requires Running (`generation/authority.rs:23`) | Keep existing names and semantics; preserve unknown descriptor fields if ever rewritten |
| Manifest schema, generationId, format | Schema/id check (`generation/manifest.rs:396`); format chooses Legacy `memory/db` or V2 generation root (`generation/read.rs:76`) | Keep both formats for existing reads; only V2 mutable |
| embedding (explicit null or bound JS/native object) | Resolver rejects absent/unreadable identity (`generation/read.rs:247`); vector read/write preflight | Keep three-way null/missing/invalid distinction and both wire forms |
| state, initializationOrigin | First native binding requires Active/Empty for an unbound active target (`generation/embedding_binding.rs:80`) | Keep binding eligibility; ordinary active reads/writes do not require Ready/acceptance |
| canonicalSnapshotId / canonicalSnapshotPath | Parsed by active resolution (`generation/read.rs:62`) but Active returns no snapshot (`:87`); candidate-only comparisons (`:67`) | Preserve existing values as opaque metadata; stop computing snapshot paths on Active once candidates go |
| schemaVersion, extractionVersion, rankingVersion, unicodeVersion, icuVersion | Written by fresh constructor (`generation/manifest.rs:368`); no production stage/recall reader of these manifest fields found | Retain wire values/passthrough. Live extraction version comes from notice/job (`completion/consumer/process.rs:257,437`), not a manifest-driven full re-extraction |
| snapshot hashes/bytes/revisions, source inventory/counts, readiness, requiredAcceptancePassed, acceptanceBinding | Typed historical metadata (`generation/manifest.rs:306,319,328,335,342`); evaluated by U control operations | Preserve as raw JSON on existing manifests; remove execution logic after dependencies vanish |

Parsing a field is different from using it as a serving gate. Unknown-field preservation already exists (`generation/manifest.rs:345`). Narrowing the typed manifest must move obsolete keys into passthrough, not discard them on the first embedding bind. Keep existing fresh output initially, including inert labels, until format-pin coverage proves a smaller constructor safe. No recall/ranking algorithm or version policy changes are part of this plan.

## On-disk compatibility and size limits of this analysis

No migration, directory rename, pointer reset or automatic user-data deletion. New code must open the current folder as it stands, leave inactive generations alone, and write the same active graph/Lance/cache paths. The descriptor remains authoritative even if a manifest state lags an old pointer transition: active resolution checks schema/id/format, not qualification (`generation/read.rs:243`; `generation/authority.rs:23`). Removing the uncalled cutover repair helper must not introduce a stricter startup gate.

| Artifact under the memory root | Runtime today | Disk disposition / size |
|---|---|---|
| `active-generation.json` | Read on resolution/authority; bootstrap writes last | Required; JSON bytes, actual owner size unmeasured |
| `generations/<active-id>/manifest.json` | Read/parse on resolution; first native bind can rewrite it | Required; includes dormant metadata that must round-trip |
| Active `graph.sqlite` and SQLite sidecars | Source registration, job claims, receipts, graph recall, health | Required; do not remove attempt/receipt tables or change WAL handling |
| Active `butler.lance/` | Queries, upserts, persisted receipts and optimize | Required; row schema and stored embedding-version filters stay (`generation_vectors/search.rs:90`; `generation_vectors/rows.rs:117,181`) |
| Active `hot/cache.md`, associated lock/audit artifacts | Cache reads/writes, prompt and health; audit is written as publication evidence | Keep publication paths (`generation/cache.rs:72,81`; `generation/cache/publication.rs:151`); no automatic cleanup of `hot/` |
| Retired legacy generation manifest and `memory/db/{graph.sqlite,butler.lance,hot/}` | Not used by Active V2 generation resolution; would be read if descriptor still selects Legacy (`generation/read.rs:76`) | Dormant only when actually retired/unselected; keep intact for manual recovery. Other legacy services may still access `memory/db`; do not classify all legacy data as garbage |
| `source-snapshot/runtime/conversation-store.sqlite`, typed snapshot directories, `memory-source-inventory.json`, `source-snapshot-<hash>/...` | Only candidate branch/control operations; Active uses live canonical/source root (`generation/read.rs:80,87`; `generation/cache.rs:136,261`) | Dormant rebuild artifacts; duplicates can dominate disk usage. Snapshot copy path at `generation/rebuild.rs:250,288,295`; refresh versions at `generation/rebuild/refresh.rs:203` |
| `qualification/`, prior/staged qualification bundles, referenced verification evidence | Only U qualification/activation/rollback (`generation/qualification_service.rs:254,342`; `generation/cutover/qualification.rs:45`) | Dormant evidence; preserve even after code deletion |
| Other unselected generation directories | No production directory enumeration to activate them; resolver opens descriptor-selected id | Dormant for generation serving; preserve complete directories, including graphs/vectors |

**Actual owner artifact bytes are unknown.** The task prohibits owner-folder access and supplies no size manifest; an honest numeric disk total cannot be produced here. Source-line counts are not disk savings. Potential dormant bytes are the sum of allocated sizes of unselected directories, snapshot versions and qualification bundles, counting hardlinks/shared files once; apparent size and allocated size must be reported separately (SQLite/Lance versions and sparse files can differ). If needed later, the owner can provide a metadata-only relative-path/size listing, without conversation contents. No disk-space reclaim is promised by deleting Rust source.

The repo's scale guidance (repo-root `plans/README.md:42`) describes roughly 1.3 GB App DB, 7 GB BTCC DB and 1.5 GB transcripts; these are workload budgets, not sizes of this owner's generation snapshots. They must not be substituted for measured dormant-artifact bytes.

Compatibility acceptance for any stage that changes reads/serialization: E2E opens a synthetic existing active V2 folder with JS identity, historical snapshot/readiness/acceptance metadata, extra unknown fields and a retired legacy sibling. Recall still returns complete results; a native write uses the same generation id and numerical compatibility domain; required metadata survives any manifest write; retired files remain byte-identical. Also cover native bound identity, explicit null eligible Empty identity, malformed/absent embedding and incompatible assets. Copy format goldens/synthetic fixtures only; never inspect the owner folder.

## Independently shippable stages

Run stages in order. Estimates below distinguish baseline unused-file lines from trimming mixed LIVE files and obsolete tests; they are budgets for review, not a reason to weaken tests. API re-exports/imports must be removed with each leaf deletion. Retain dependent declarations until their last caller goes. A task can stop after any stage with production behavior and disk schema unchanged.

| Stage | Remove / keep | Estimated lines removed | Tests and ship gate | Risk, rollback and future substitute |
|---|---|---:|---|---|
| 1. Remove cutover commands | Delete `generation/cutover.rs` and its four children, exported stamps/outcomes and uncalled pending repair. Keep descriptor read/bootstrap atomic writer, authority and qualification temporarily | 1,284 unused file lines; about 0–60 obsolete pin/helper lines | Remove transition-writer assertions from `generation/format_pin.rs:303`; keep descriptor/manifest compatibility pins using existing serialized fixtures. Run common suite below | Risk: accidentally removing a live pointer reader or tightening manifest-state requirements. Roll back source commit; no disk rollback. Loses online qualified activation/multi-step rollback. Future maintenance stops writers and swaps one durable pointer; old directory remains available |
| 2. Remove qualification engine | Delete `generation/qualification.rs`, its non-test children, `qualification_service.rs`, and validator exports. **Keep `qualification_witness.rs`**: refresh/readiness/reconcile still use it (`generation/rebuild/refresh.rs:93`; `generation/rebuild/readiness.rs:102`; `generation/reconcile.rs:54`). Keep manifest historical evidence values | 2,619 unused file lines; 85 qualification test lines plus about 60–100 obsolete format-pin lines | Delete only qualification acceptance/hash tests and writer pins (`generation/qualification/tests.rs`; `generation/format_pin.rs:317`). Preserve parsing/round-trip pins for owner manifests. Run common suite | Risk: loss of metadata on a future bind, or witness deleted prematurely. Revert commit; no evidence files touched. Loses certificate/commit-bound acceptance bundles. Future model/extractor task uses a small explicit E2E/recall evaluation report before an offline swap |
| 3. Remove candidate repair/reconciliation controls | Delete `generation/{reconcile,repair_inputs,retry_failed,set_extractor}.rs`, `generation_vectors/representative.rs`, `graph/{retry_failed,vector_representative}.rs` and `graph/operator_repair.rs` with its policy/repair/request children, exports/wrappers. Keep persisted model-policy table/read behavior (`graph/projection.rs:167`) and live vector claim recovery, normal retry schedules, upserts and receipts | 2,208 unused file lines; about 95 representative-race test lines | Remove representative-commit race from `generation/rebuild/tests.rs:220`; retain readiness/preparation races until their code goes. Keep consumer vector/cache recovery tests and common suite | Risk: confusing operator reset with live interrupted-work recovery. Revert code; no persisted state changed. Loses dormant manual failed-job reset and candidate input/model representative repair. Future repair is an explicit bounded job reset under the same lease or full side-directory rebuild, with dedicated acceptance |
| 4. Remove snapshot preparation/refresh | Delete prepare, legacy-baseline registration, build-inventory API, inspect, refresh, typed snapshot copy and unused cursor reader. Keep `rebuild/build_inventory.rs` internally (readiness calls it at `rebuild/readiness.rs:378`), and a small `rebuild` facade with inventory/readiness types/functions until stage 5; keep witness and live typed registration | About 1,416 unused file lines (1,446 minus ~30 facade lines); about 10–40 cursor/wrapper lines plus 100–150 obsolete preparation/pin support lines | Remove preparation race and prepare/inspect pins after replacing live format coverage with direct fixture parsing. Retain readiness race and required fixture support. Run registration/typed lifecycle pins and common suite | Risk: deleting typed registration alongside typed snapshot copy, or touching nonfresh bootstrap. Revert commit. Loses online delta-refresh/source inventory pagination and legacy-baseline creation. Future full re-extraction uses current canonical/typed source readers into a new directory during an explicit maintenance operation; no frozen source-copy hierarchy unless that operation needs it |
| 5. Remove whole-candidate readiness and witnesses | Delete remaining rebuild facade, internal build inventory, inventory/typed inventory, readiness/facts/cache evaluator, `qualification_witness.rs`, `generation_vectors/readiness.rs`, `graph/readiness.rs` source scan and `graph/readiness/stages.rs`. Remove dormant `generation/cache.rs:136,252` reconciliation branch first. Keep/move `graph/readiness/cache.rs:78` retained-entry validation and receipt views used by live prompts/health/publication; remove only its candidate requeue/outcome methods | About 2,533 unused file lines (includes retained stage-4 facade); about 60–100 mixed cache/helper lines and 100–180 remaining rebuild test/pin lines | Remove remaining candidate-readiness race/support (`generation/rebuild/tests.rs:133`). Keep hot-cache pins, schema pins, receipt recovery and common suite; synthetic existing-folder E2E is required | Risk: shared validation mistaken for readiness-only logic; returning stale or unbacked hot content. Revert commit. Loses whole-candidate proof of every source/vector/retained-cache row and revision/file witnesses. Future offline rebuild validates full counts, source hashes, vector identity and representative recall examples before swapping; no per-runtime qualification state machine |
| 6. Narrow the active-directory contract | Remove Rebuild target and snapshot handle branches, projection resolver's inactive fallback, consumer `with_rebuild_target`, strict second init entry, optional rebuild typed cursor plumbing. Narrow manifest typed lifecycle fields into preserved opaque JSON; keep initial wire output, active resolution, lease/authority, embedding binding/checks and all live stages | About 250–450 mixed LIVE/helper lines, net of small compatible reader/API code; no whole live module deleted | Keep generation id/hash and JS embedding wire pins, cache format pins, registration/semantic/lifecycle and schema pins. Run all common tests plus synthetic folder/no-write refusal cases | Risk: wire incompatibility, unbound binding regression, active writes relabeling JS vectors. Revert code; old binary must still open folder after a native write. Loses inactive candidate search/processing in normal consumer. Future maintenance owns a separate reader/writer context for its new directory, then changes one pointer |

Stages 1–5 account for **all 10,060 file-level UNREACHABLE lines** (with ~30 facade lines temporarily carried across stages 4/5). Additional removals are estimates: roughly 500–760 dormant tests/helpers and 320–630 mixed-file lines including stage 6, giving approximately **10.9k–11.5k net source lines** removed. Test support overlaps must be counted once at implementation time; new compatible parsing tests reduce net savings. Keep the 2,567 registration test lines unless a test exclusively specifies a removed capability. The objective is less lifecycle machinery, not a target LOC number.

Stage-4 dependency trap: whole-readiness still uses the source-inventory reader (`generation/rebuild/readiness.rs:373`) and witnesses, so the facade retains the internal build-inventory reader plus both inventory modules until stage 5. Stage-5 trap: `graph/readiness/cache.rs` is LIVE despite its directory name; move its live portion before deleting its parent. Retain the `VectorReadinessRow` shape while candidate representative/readiness helpers still require it, then remove it with their final caller. These ordering constraints make the leaf deletions compile independently.

## Verification required for implementation tasks

Every stage must run one cargo build at a time, `-j 8`; E2E at most eight threads. Set `CARGO_HOME`/`RUSTUP_HOME` to existing caches before assigning fresh temporary `HOME` and `BUTLER_DATA`. Stub/replay only, no live recording. Find additional affected existing tests with `rg` at implementation time; run them alongside these, not just newly written tests.

The common E2E gate is `butler-e2e --test memory --test memory_hot_cache --test memory_idle --test migration --test durable_configuration --test cli_surface`, with the repository's harness configuration. In particular retain:

- `memory.rs:31,83,187`: source survives restart, fresh cross-chat memory, user-intent recall arguments.
- `memory.rs:256,287,319`: bootstrap does not hold service readiness, nonfresh folders unchanged, paraphrase/vector recall succeeds.
- `memory_hot_cache.rs:47`: active cache refresh reaches another chat.
- `memory_idle.rs:115,177,220`: daily cycle/crash recovery, idle graph/lock no writes, changed sources caught without restart. Timed checks must also verify complete/latest results; no truncation, stale caching or budget changes.
- `migration.rs` (including MIG-01 refused legacy folder unchanged), `durable_configuration.rs`, `cli_surface.rs`: startup/data compatibility and command surface retained.

Existing non-E2E regression coverage to preserve/run for the affected paths: `generation/tests.rs` id/hash/JS wire pins; `generation/cache/format_pin.rs`; `graph/schema/tests.rs`; `registration/tests.rs` and its semantic/provider/lifecycle/exact-query/identity-history children; `completion/consumer/process/tests/vector.rs` and the remaining consumer tests. New non-E2E tests are permitted only for race/security/pure-logic/format-pin and must be tagged; do not add implementation-mirroring tests or raise ratchets.

Each implementation task needs targeted `cargo check`, tests above, `cargo fmt`, memory-crate clippy with `-D warnings` and repo source-check before committing/pushing if authorized. Test disappearance is valid only when the specified capability was intentionally removed; a failure in retained behavior blocks shipment. Document baseline failures honestly and follow the existing issue-search/flakiness rule. This design-only task has no Rust change and does not need cargo builds or model-backed E2E.

## Keep these safeguards

Keep crash-safe claims/receipts and stage replay: provider intent/answer/plan persistence is on the live path (`registration/projection/stages.rs:83,98`; `registration/projection/stages/finalize.rs:29`; `graph/stages.rs:62,75,103,121`). Nonces, owner checks, dead-owner recovery and current source revisions prevent duplicate or stale writes. They are separate from generation qualification.

Keep vector intent/outcome flags, durable unit receipts, persisted-row reconciliation and numerical compatibility (`completion/consumer/process/vector.rs:107,139,212,226,243`). Lance and SQLite do not share a transaction; removing the receipt bridge creates a crash window. Keep cache changed-bytes publication followed by durable receipt/outcome commit (`generation/cache.rs:232`; `graph/cache_quantum.rs:149`), structured entry source references and live validation (`prompt/memory.rs:162`). Keep graph schema/format compatibility, source hydration and explicit forget/supersession handling.

Keep writer coordination, secure filesystem/data-root authority, cancellation lease ownership and private atomic writes. Keep fresh initialisation before memory catch-up, no-write nonfresh/legacy refusal and absent descriptor fallback. Keep read-only work probes and change-driven catch-up; do not introduce scans on recall, per-poll full manifests/directories, new blocking I/O on Tokio workers or tighter service readiness coupling. Existing pointer rechecks and manifest reads can stay; this task does not mandate a caching redesign.

## Owner decisions

1. **Remove unused public rebuild/activation APIs, or retain a supported maintenance API now?** Recommend remove. No repository production route exists; keeping public-but-unused operations commits the product to unexercised behavior. Approve stages 1–5 on that basis; external library consumers, if any, must be identified before implementation.
2. **Future model/extractor rebuild while service is stopped, or concurrent online rebuild with catch-up?** Recommend stopped-service maintenance: construct a new graph/vector/hot directory alongside the old, verify full content/counts and recall, durably swap one pointer, restart. Online operation would require a separately justified concurrency design, not preservation of today's dormant machinery. Do not revive snapshot/qualification state machines preemptively.
3. **Remove the uncalled failed-job operator-reset API, or build a user-facing repair command now?** Recommend remove in stage 3; retain live automatic crash recovery/retry. Add a small explicit repair command only when an observed production failure establishes the required semantics.
4. **Keep historical manifest fields as opaque passthrough, or keep their full typed Rust models?** Recommend opaque passthrough in stage 6 after compatibility E2E/format pins; retain current initial wire output during this sequence. Both preserve owner disk bytes/values; neither requires migration. Do not delete JS embedding compatibility or reinterpret its stored version.
5. **Leave dormant artifacts indefinitely, or later provide an explicit owner-approved cleanup command?** Recommend leave them during this simplification; a separate metadata-only size audit can justify a cleanup task. Never auto-delete retired generations, source snapshots or qualification evidence. Actual allocated/apparent sizes remain unmeasured in this task.

## Design-task validation and limitations

Inventory and caller/guard searches were performed against the baseline; no reachability-removal experiments or production code edits. Static inventory validation passed: 121 unique modules, 27,810 physical source lines and 235 explicit source locations checked; directory coverage and stage estimates reconcile. Initial validator attempts needed path-resolution corrections for `cognition.rs` and E2E `memory.rs`; these were validator errors, not product/test failures. Staged `git diff --check` validates whitespace. No cargo check, unit test, E2E, performance or owner disk measurement was run. All behavioral validation listed above is an acceptance requirement for later implementation, not a claim of current execution. The configured worktree target directory must be absent when this task finishes.
