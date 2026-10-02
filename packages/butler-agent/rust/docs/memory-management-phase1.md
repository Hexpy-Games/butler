# Memory management phase 1 implementation

This branch adds backend inventory and explicit cleanup, without a reset endpoint.
Current readers force a deliberately conservative eligibility set. Cleanup removes
only empty UUID generation directories with no descriptor/manifest references.
It retains every nonempty generation and all nested snapshots/evidence. An unreadable
manifest blocks deletion and reports the reference inventory as unavailable. Empty unpublished directories have no graph, snapshot,
manifest or evidence for a production reader to open. No age heuristic is used.

The normal inventory GET clones four cached cards and reads the atomic writer and publication epochs:
O(four cards plus bounded health metadata), zero filesystem reads, directory walks
or database opens. Explicit Check performs the adoption scan on blocking workers:
O(files + graph aggregate work + existing health source/log scans). No timer,
startup scan, extraction, embedding or periodic management worker is added.
Automatic allocation also includes operation receipts and pending trash.
Leased writer admission and completion invalidate the measurement; profile consent
and clear also invalidate it. The existing work notification invalidates queued
source publications before a consumer obtains the lease. Restart starts unknown instead of trusting a dirty
counter. This uses request-driven adoption rather than durable transactional
per-kind summaries; until the separate pinned handle index lands, a populated
pinned card has unknown active count. Project count is capsule files (not registered
projects). Unsupported allocation measurement is null, never logical file length.

## Reader audit

Paths below are relative to `packages/butler-agent/rust/crates/`.
The following retained resolver, direct-open and legacy path construction sites
were audited in this tree. Repeated opens in the same flow are included. Generic
filesystem readers remain gated by their caller's descriptor/manifest target.

- `butler-memory/src/management/safety.rs:50` — `crate::cognition::resolve_active_generation(root, paths).map_err(io::Error::other)`
- `butler-memory/src/cognition/graph_consolidation.rs:47` — `let handle = resolve_active_generation(&self.data_root, &self.paths)?;`
- `butler-memory/src/cognition/graph_consolidation.rs:66` — `let current = resolve_active_generation(&data_root, &paths)?;`
- `butler-memory/src/cognition/hot_cache.rs:76` — `let hot_root = memory_root.join("hot");`
- `butler-memory/src/cognition/hot_cache.rs:237` — `let db_root = memory_root.join("db");`
- `butler-memory/src/cognition/vector_optimize.rs:78` — `let generation = resolve_active_generation(&self.data_root, &self.paths)?;`
- `butler-memory/src/cognition/source_reference.rs:53` — `let generation = resolve_active_generation(&self.data_root, &self.paths)?;`
- `butler-memory/src/cognition/registration.rs:277` — `let handle = resolve_generation(&input.data_root, environment, &input.target)?;`
- `butler-memory/src/cognition/mcp_graph.rs:48` — `let db_path = memory_root.join("db/graph.sqlite");`
- `butler-memory/src/cognition/generation_vectors/adapter.rs:123` — `resolve_projection_generation(&self.data_root, &self.paths, input.generation_id)?;`
- `butler-memory/src/cognition/legacy/lance_writer.rs:61` — `let db_root = memory_root.join("db");`
- `butler-memory/src/cognition/legacy/session_sync.rs:238` — `memory_root.join("db/session-sync-offset.json")`
- `butler-memory/src/cognition/legacy/memory_import.rs:150` — `let db_root = memory_root.join("db");`
- `butler-memory/src/cognition/legacy/memory_import.rs:181` — `.join("db/imported-sessions.txt")`
- `butler-memory/src/cognition/registration/typed.rs:170` — `let current = resolve_generation(&input.data_root, &self.environment, &input.target)?;`
- `butler-memory/src/cognition/registration/typed.rs:259` — `let handle = resolve_generation(&input.data_root, environment, &input.target)?;`
- `butler-memory/src/cognition/registration/typed_lifecycle.rs:170` — `let current = resolve_generation(&self.data_root, &self.environment, &target)?;`
- `butler-memory/src/cognition/registration/projection.rs:181` — `let handle = resolve_generation(&input.data_root, environment, &input.target)?;`
- `butler-memory/src/cognition/memory_health/sources.rs:119` — `let hot = scan_files(&memory_root.join("hot"), ".md", None, Stems::Skip)?;`
- `butler-memory/src/cognition/memory_health/sources.rs:120` — `let hot_topics = scan_files(&memory_root.join("hot/topics"), ".md", None, Stems::Skip)?;`
- `butler-memory/src/cognition/memory_health/sources.rs:134` — `let vector_stats = read_vector_stats(&memory_root.join("db/vector-stats.json"));`
- `butler-memory/src/cognition/memory_health/sources.rs:135` — `let graph = memory_root.join("db/graph.sqlite");`
- `butler-memory/src/cognition/memory_health/serving.rs:30` — `let Ok(handle) = resolve_active_generation(data_root, paths) else {`
- `butler-memory/src/cognition/memory_health/serving.rs:44` — `let unchanged = resolve_active_generation(data_root, paths)`
- `butler-memory/src/cognition/memory_health/serving.rs:378` — `let cache = resolve_active_generation(data_root, paths).map_or_else(`
- `butler-memory/src/cognition/memory_recall/tool.rs:106` — `crate::cognition::resolve_active_generation(data_root, environment)?;`
- `butler-memory/src/cognition/memory_recall/service.rs:233` — `let generation = resolve_active_generation(&self.data_root, &self.environment)?;`
- `butler-memory/src/cognition/generation/initialize.rs:57` — `.and_then(|()| resolve_active_generation(&data_root, &environment));`
- `butler-memory/src/cognition/generation/rebuild.rs:332` — `let db = sqlite::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)`
- `butler-memory/src/cognition/generation/rebuild.rs:363` — `let mut file = File::open(path).map_err(io_error)?;`
- `butler-memory/src/cognition/generation/cutover.rs:105` — `let bytes = fs::read(path)`
- `butler-memory/src/cognition/generation/manifest.rs:428` — `let bytes = fs::read(path).map_err(|source| error(code).with_source(source))?;`
- `butler-memory/src/cognition/generation/reconcile.rs:37` — `let handle = resolve_generation(data_root, environment, target)?;`
- `butler-memory/src/cognition/generation/reconcile.rs:56` — `let graph = GraphRepository::open_readonly(&handle.graph_path)?;`
- `butler-memory/src/cognition/generation/reconcile.rs:126` — `let current = resolve_generation(data_root, environment, target)?;`
- `butler-memory/src/cognition/generation/set_extractor.rs:37` — `let handle = resolve_generation(data_root, environment, &target)?;`
- `butler-memory/src/cognition/generation/set_extractor.rs:74` — `let current = resolve_generation(data_root, environment, &target)?;`
- `butler-memory/src/cognition/generation/set_extractor.rs:80` — `let mut graph = GraphRepository::open(&current.graph_path)?;`
- `butler-memory/src/cognition/generation/embedding_binding.rs:42` — `let current = resolve_generation(data_root, environment, target)?;`
- `butler-memory/src/cognition/generation/qualification_service.rs:194` — `let handle = resolve_generation(data_root, environment, &target)?;`
- `butler-memory/src/cognition/generation/qualification_service.rs:435` — `let mut source = File::open(source).map_err(|source| {`
- `butler-memory/src/cognition/generation/qualification_witness.rs:80` — `let canonical = sqlite::open_with_flags(&canonical_path, OpenFlags::SQLITE_OPEN_READ_ONLY)`
- `butler-memory/src/cognition/generation/qualification_witness.rs:260` — `let cache = handle.root.join("hot/cache.md");`
- `butler-memory/src/cognition/generation/qualification_witness.rs:275` — `let graph = sqlite::open_with_flags(&handle.graph_path, OpenFlags::SQLITE_OPEN_READ_ONLY)`
- `butler-memory/src/cognition/generation/qualification_witness.rs:279` — `let table = open_table(&lance).await?;`
- `butler-memory/src/cognition/generation/qualification_witness.rs:299` — `async fn open_table(lance: &Path) -> CognitionResult<Option<Table>> {`
- `butler-memory/src/cognition/generation/qualification_witness.rs:303` — `let connection = lance_store::connect(lance)`
- `butler-memory/src/cognition/generation/qualification_witness.rs:306` — `match lance_store::open(&connection, "butler_memory").await {`
- `butler-memory/src/cognition/generation/qualification_witness.rs:328` — `let cache = handle.root.join("hot/cache.md");`
- `butler-memory/src/cognition/generation/qualification_witness.rs:336` — `Sha256::digest(fs::read(&cache).map_err(|source| {`
- `butler-memory/src/cognition/generation/retry_failed.rs:50` — `let handle = resolve_generation(data_root, environment, &target)?;`
- `butler-memory/src/cognition/generation/retry_failed.rs:104` — `let current = resolve_generation(&self.data_root, &self.environment, &self.target)?;`
- `butler-memory/src/cognition/generation/retry_failed.rs:118` — `let mut graph = GraphRepository::open(&current.graph_path)?;`
- `butler-memory/src/cognition/generation/retry_failed.rs:144` — `let bytes = fs::read(path).map_err(|source| {`
- `butler-memory/src/cognition/generation/repair_inputs.rs:65` — `let handle = resolve_generation(data_root, environment, &target)?;`
- `butler-memory/src/cognition/generation/repair_inputs.rs:113` — `GraphCandidateInputRepairRequest::parse(&fs::read(input_path).map_err(invalid)?)`
- `butler-memory/src/cognition/generation/repair_inputs.rs:139` — `let current = resolve_generation(&self.data_root, &self.environment, &self.target)?;`
- `butler-memory/src/cognition/generation/repair_inputs.rs:151` — `let canonical = ConversationSourceReader::open(&self.canonical_path)`
- `butler-memory/src/cognition/generation/repair_inputs.rs:154` — `RepairMode::Preview => GraphRepository::open_readonly(&current.graph_path)?,`
- `butler-memory/src/cognition/generation/repair_inputs.rs:155` — `RepairMode::Apply => GraphRepository::open(&current.graph_path)?,`
- `butler-memory/src/cognition/generation/cache.rs:70` — `let handle = resolve_generation(data_root, environment, target)?;`
- `butler-memory/src/cognition/generation/cache.rs:72` — `let cache = handle.root.join("hot/cache.md");`
- `butler-memory/src/cognition/generation/cache.rs:81` — `&handle.root.join("hot/cache.md.lock"),`
- `butler-memory/src/cognition/generation/cache.rs:125` — `let current = resolve_generation(&self.data_root, &self.environment, &self.target)?;`
- `butler-memory/src/cognition/generation/cache.rs:132` — `let mut graph = GraphRepository::open(&handle.graph_path)?;`
- `butler-memory/src/cognition/generation/cache.rs:206` — `let reader = ConversationSourceReader::open(&canonical)`
- `butler-memory/src/cognition/generation/cache.rs:269` — `let reader = ConversationSourceReader::open(canonical)`
- `butler-memory/src/cognition/generation/cache.rs:315` — `let reader = ConversationSourceReader::open(&canonical)`
- `butler-memory/src/cognition/generation/read.rs:77` — `GenerationFormat::Legacy => memory_root.join("db"),`
- `butler-memory/src/cognition/generation/read.rs:111` — `resolve_generation(`
- `butler-memory/src/cognition/generation/read.rs:130` — `return resolve_generation(`
- `butler-memory/src/cognition/generation/read.rs:145` — `resolve_generation(`
- `butler-memory/src/cognition/generation/read.rs:206` — `let bytes = std::fs::read(memory_root.join("active-generation.json"))`
- `butler-memory/src/cognition/prompt/memory.rs:111` — `let generation = resolve_active_generation(data_root, environment)?;`
- `butler-memory/src/cognition/prompt/memory.rs:112` — `let path = generation.root.join("hot/cache.md");`
- `butler-memory/src/cognition/prompt/memory.rs:190` — `|| resolve_active_generation(data_root, environment)?.generation_id`
- `butler-memory/src/cognition/hot_cache/receipts.rs:108` — `let db = memory_root.join("db");`
- `butler-memory/src/cognition/hot_cache/legacy_graph.rs:103` — `let db_directory = memory_root.join("db");`
- `butler-memory/src/cognition/hot_cache/transcript_index.rs:221` — `let db_root = memory_root.join("db");`
- `butler-memory/src/cognition/hot_cache/import.rs:119` — `let cache = memory_root.join("hot/cache.md");`
- `butler-memory/src/cognition/generation/qualification/io.rs:257` — `let file = File::open(&path).map_err(|source| {`
- `butler-memory/src/cognition/generation/qualification/io.rs:268` — `let file = File::open(path).map_err(|source| {`
- `butler-memory/src/cognition/generation/cutover/activate.rs:64` — `let handle = resolve_generation(data_root, environment, &target)?;`
- `butler-memory/src/cognition/generation/cutover/descriptor.rs:114` — `let target_manifest = fs::read(&target_manifest_path).map_err(io_unavailable)?;`
- `butler-memory/src/cognition/generation/cutover/descriptor.rs:213` — `let bytes = fs::read(path).map_err(io_unavailable)?;`
- `butler-memory/src/cognition/generation/cutover/rollback.rs:286` — `let handle = resolve_generation(data_root, environment, &target)?;`
- `butler-memory/src/cognition/generation/cutover/rollback.rs:428` — `let handle = resolve_generation(data_root, environment, &target)?;`
- `butler-memory/src/cognition/generation/initialize/empty.rs:46` — `memory_root.join("db/graph.sqlite"),`
- `butler-memory/src/cognition/generation/initialize/empty.rs:53` — `for path in [memory_root.join("db/butler.lance"), memory_root.join("hot")] {`
- `butler-memory/src/cognition/generation/initialize/empty.rs:69` — `ConversationSourceReader::open(path).map_err(|source| unreadable().with_source(source))?;`
- `butler-memory/src/cognition/generation/initialize/empty.rs:116` — `sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)`
- `butler-memory/src/cognition/generation/rebuild/legacy_baseline.rs:105` — `&fs::read(&manifest_path).map_err(io_error)?,`
- `butler-memory/src/cognition/generation/rebuild/legacy_baseline.rs:161` — `serde_json::from_slice(&fs::read(path).map_err(|source| {`
- `butler-memory/src/cognition/generation/rebuild/typed_snapshot.rs:115` — `let mut input = File::open(source).map_err(io_error)?;`
- `butler-memory/src/cognition/generation/rebuild/readiness.rs:99` — `let handle = resolve_generation(data_root, environment, target)?;`
- `butler-memory/src/cognition/generation/rebuild/readiness.rs:161` — `&handle.root.join("hot/cache.md"),`
- `butler-memory/src/cognition/generation/rebuild/readiness.rs:183` — `let current = resolve_generation(data_root, environment, target)?;`
- `butler-memory/src/cognition/generation/rebuild/readiness.rs:238` — `let current = resolve_generation(data_root, environment, target)?;`
- `butler-memory/src/cognition/generation/rebuild/readiness.rs:252` — `&current.root.join("hot/cache.md"),`
- `butler-memory/src/cognition/generation/rebuild/inventory.rs:115` — `let bytes = fs::read(path)`
- `butler-memory/src/cognition/generation/rebuild/inventory.rs:228` — `let reader = ConversationSourceReader::open(canonical_path)`
- `butler-memory/src/cognition/generation/rebuild/inventory.rs:304` — `let connection = sqlite::open_with_flags(canonical_path, OpenFlags::SQLITE_OPEN_READ_ONLY)`
- `butler-memory/src/cognition/generation/rebuild/refresh.rs:172` — `let handle = resolve_generation(data_root, environment, &target)?;`
- `butler-memory/src/cognition/generation/rebuild/refresh.rs:394` — `serde_json::from_slice(&fs::read(&paths.active).map_err(|source| {`
- `butler-memory/src/cognition/generation/rebuild/inspect.rs:102` — `let db = sqlite::open_with_flags(&graph, OpenFlags::SQLITE_OPEN_READ_ONLY)`
- `butler-memory/src/cognition/generation/rebuild/build_inventory.rs:120` — `let connection = sqlite::open_with_flags(`
- `butler-memory/src/cognition/generation/rebuild/build_inventory.rs:156` — `let graph = GraphRepository::open(&handle.graph_path)?;`
- `butler-memory/src/cognition/generation/cache/health.rs:62` — `let content = match fs::read_to_string(handle.root.join("hot/cache.md")) {`
- `butler-memory/src/cognition/generation/cache/health.rs:118` — `let graph = GraphRepository::open_readonly(&handle.graph_path).ok()?;`
- `butler-memory/src/cognition/generation/cache/health.rs:119` — `let Ok(canonical) = ConversationSourceReader::open(&conversation_store_path(data_root)) else {`
- `butler-memory/src/cognition/generation/cache/health.rs:140` — `let db = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;`
- `butler-memory/src/cognition/generation/cache/health.rs:152` — `let Ok(db) = sqlite::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {`
- `butler-memory/src/cognition/generation/rebuild/readiness/facts.rs:12` — `let canonical = ConversationSourceReader::open(`
- `butler-memory/src/cognition/generation/rebuild/readiness/facts.rs:19` — `let graph = GraphRepository::open_readonly(&handle.graph_path)?;`
- `butler-memory/src/cognition/generation/rebuild/readiness/facts.rs:71` — `let cache_text = match fs::read_to_string(handle.root.join("hot/cache.md")) {`
- `butler-memory/src/cognition/generation/rebuild/inventory/typed.rs:67` — `serde_json::from_slice(&fs::read(binding_path).map_err(|source| {`
- `butler-memory/src/cognition/generation/rebuild/inventory/typed.rs:113` — `let bytes = fs::read(rules.join(&name)).map_err(unavailable)?;`
- `butler-memory/src/cognition/completion/consumer/process.rs:243` — `resolve_active_generation(&owned.data_root, &owned.environment)`
- `butler-memory/src/cognition/completion/consumer/process.rs:478` — `Some(target) => resolve_generation(&input.data_root, &input.environment, target),`
- `butler-memory/src/cognition/completion/consumer/process.rs:479` — `None => resolve_active_generation(&input.data_root, &input.environment),`
- `butler-memory/src/cognition/completion/consumer/process/typed.rs:46` — `let active = resolve_active_generation(&input.data_root, &input.environment)?;`
- `butler-memory/src/cognition/completion/consumer/process/vector.rs:215` — `let current = resolve_generation(&input.data_root, &input.environment, &target)?;`
- `butler-memory/src/cognition/completion/consumer/process/vector.rs:230` — `let current = resolve_generation(&input.data_root, &input.environment, &target)?;`
- `butler-memory/src/cognition/completion/consumer/process/vector.rs:233` — `let final_generation = resolve_generation(&input.data_root, &input.environment, &target)?;`
- `butler-memory/src/cognition/completion/consumer/process/vector.rs:299` — `let current = resolve_generation(&input.data_root, &input.environment, &target)?;`
- `butler-memory/src/cognition/legacy/recall/corpus.rs:32` — `for path in list_markdown_files(data_root, &memory_root.join("hot"))? {`
- `butler-memory/src/cognition/legacy/recall/corpus.rs:35` — `for path in list_markdown_files(data_root, &memory_root.join("hot/topics"))? {`
- `butler-memory/src/cognition/legacy/recall/corpus.rs:96` — `let graph = graph::load(data_root, &memory_root.join("db/graph.sqlite"), project_id)?;`
- `butler-memory/src/cognition/project_capsule/source/graph.rs:23` — `let path = memory_root.join("db/graph.sqlite");`
- `butler-memory/src/cognition/project_capsule/source/graph.rs:49` — `let path = memory_root.join("db/graph.sqlite");`
- `butler-agent/src/host/memory_jobs/daily.rs:227` — `let generation = resolve_active_generation(&self.data_root, &self.paths)`
- `butler-agent/src/host/memory_jobs/sync.rs:61` — `resolve_active_generation(data_root, paths).map_err(error)?;`
- `butler-agent/src/host/memory_jobs/transcript_sync.rs:66` — `&memory_root.join("db/session-sync-offset.json"),`
- `butler-agent/src/host/memory_jobs/transcript_sync.rs:75` — `std::fs::create_dir_all(memory.join("db")).map_err(|source| {`
- `butler-agent/src/host/memory_jobs/transcript_sync/hot.rs:110` — `memory.join("hot/topics").join(format!("{slug}.md"))`
- `butler-agent/src/host/memory_jobs/transcript_sync/hot.rs:112` — `_ => memory.join("hot/cache.md"),`

The new management readers also run under that lease and close all enumeration
handles before rename. They introduce no reader that retains an artifact across
lease release:

- `butler-memory/src/management/inventory.rs:57` / `measurement.rs:35` — explicit
  allocation scans enumerate generations and legacy stores, including nested snapshots/evidence.
- `butler-memory/src/management/inventory.rs:154` — opens only the resolved active graph readonly.
- `butler-memory/src/management/cleanup/plan.rs:15` / `:34` — candidate enumeration and emptiness check.
- `butler-memory/src/management/cleanup/plan.rs:82` / `:85` — enumerates generations and reads their manifests.
- `butler-memory/src/management/cleanup/plan.rs:103` — allocation measurement of retained legacy stores.
- `butler-memory/src/management/cleanup.rs:153` / `:211` — reads and rechecks the active manifest.
- `butler-memory/src/management/cleanup.rs:192` — rechecks candidate emptiness immediately before rename.

All active descriptor and every discovered generation manifest byte string are
checked for references before an empty directory becomes eligible. Under the
existing consolidation lease, the active descriptor and active manifest are
re-read immediately before rename. Source and trash parents are synced after
rename. A receipt records the source and measured allocation first. Deletion
uses remove_dir, which refuses a directory that acquired content. A failed rename
is kept as in-use/rename-failed, including on Windows. Only an explicit subsequent
cleanup reconciles renamed receipt items; startup never touches trash.

## App surface

All routes use existing gateway authentication and App envelopes:

- GET `/memory/inventory`: `{state, revision, measured_at, kinds,
  dead_letter_allocated_bytes}`. Cards contain `kind`, `count_unit`, `item_count`,
  `pending_count`, `allocated_bytes`, `content_updated_at`, `health`. Automatic
  `health.conversation_episodes_without_vectors` counts each current conversation
  episode once; the rest of health preserves the existing operator health shape.
- POST `/memory/inventory/check`: explicit adoption measurement, same payload.
- POST `/memory/cleanup`: `{operation_id: UUID, inventory_revision: integer}`;
  HTTP 202 returns durable receipt, or replays a completed receipt.
- GET `/memory/cleanup/<UUID>`: durable receipt for initial view/reconnect.
- DELETE `/memory/cleanup/<UUID>`: requests cancellation of current reclamation.

Receipts/events contain `operation_id`, `inventory_revision`, `phase`, `sequence`,
`bytes_reclaimed`, `items: [{name, allocated_bytes, outcome, reason}]`.
Progress/completion use the existing change-event stream as `memory.operation`;
there are no UI polling timers. Operation IDs replay identical payloads; a
changed inventory revision for the same ID conflicts. No profile reset endpoint.

Dead letters, live SQLite/Lance/alias data, pinned archives, chats, canonical
sources and legacy stores are never deleted. Current-generation source snapshots
and qualification files remain even when active serving reads live sources:
candidate/qualification/rollback readers still exist in this branch.

## Offline acceptance (Linux, disposable partial snapshot)

The driver in `crates/butler-memory/examples/memory_management_probe.rs` was run
against a copy of `/home/yeonw/workspace/bench/butler-data`, without an agent,
model calls or extraction. This snapshot lacks other source snapshots and the
pinned/profile/project stores; its zero counts describe this copy only.

| Kind | Active count | Allocated bytes | Content updated |
| --- | ---: | ---: | --- |
| Pinned | 0 | 0 | unknown |
| Automatic conversation episodes | 714 | 1,907,412,992 | 2026-09-28T05:55:02.975Z |
| Profile | 0 stable, 0 pending | 0 | unknown; consent off |
| Project capsules | 0 | 0 | unknown |

Dead-letter allocation was 0. Existing health reported 155 incomplete vector
units across its existing health scope; the conversation-episode count with
incomplete required vector units was 9, counted once per eligible episode.
Explicit Check took 1,048 ms; the complete cached four-card read took 157 us.
Cleanup took 13 ms and reclaimed 0 bytes. It kept:

- `generations/73c90516-3dcf-4f9a-b7f2-238a15a3973d`: 1,907,400,704 bytes,
  active generation.
- `generations/7f3f8feb-7dd9-4a39-8a5a-557ca862bc0e`: 8,192 bytes,
  descriptor/manifest reference.

The same direct recall query returned four ranked results before and after;
all content, ordering, evidence and coverage were equal. Continuation tokens
were compared by presence, and request timings were excluded. A fixed request
clock prevented age drift. Recall took 3,194 / 1,900 ms. This verification used
existing lexical/graph retrieval with vectors disabled; vector inference was
not exercised. No private memory text was printed.

A separate synthetic fixture cancelled immediately after rename, preserved trash
when constructing a new backend, reclaimed 4,096 bytes on explicit resume and
replayed the identical completed receipt. Both inventory and cleanup refused a
synthetic pre-BTCC legacy folder without adding or changing files. Nonempty
retired generations and nested source snapshots are exercised by the App E2E
and retained for the audited reader reasons. The disposable copy is removed at
completion; the private source snapshot is never modified.

## Validation and remaining profile work

The existing stub suites passed: app_state (6), cli_surface (1),
durable_configuration (1), memory (6), memory_hot_cache (1), memory_idle (3),
migration (2), personalization (1), personalization_defaults (4), settings (6).
MEM-IDLE measured 60.001640092 seconds with zero graph commits and leases and
unchanged graph, WAL and lock files. The memory vector scenario initially lacked
its required local embedding-assets setting; with that prerequisite configured,
the complete memory suite passed. There is no memory_wiring E2E file in this tree;
the existing memory, hot-cache and idle suites exercise those wiring paths.

The new memory_management file has two passing scenarios and one deliberately
failing reproduction, wiring_profile_clear_relearns_from_old_chats. With a fixed
clock and stub model, the existing clear removes the learned preference, then
consolidation learns it again from the old chat (one entry instead of zero).
Pinned memories survive both clear and subsequent consolidation. No profile
reset is implemented or advertised. The minimum phase-2 fix is a durable
admission boundary covering BTCC admission, canonical read eligibility and
extraction registration; retaining only the old scan offset is insufficient.
The current clear in butler-memory/src/profile/storage.rs:218 deletes coverage
and the scan offset at :233–235.

The refused-legacy E2E also verifies that failed agent startup adds no files or
directories. Startup now applies the existing unsupported-data check before
instance locks, credentials and runtime initialization. This makes the existing
refusal effective before any startup writes.

Formatting, clippy with warnings denied, source-check and licence generation
verification passed. No dependencies or licence fingerprint changed. Windows
allocation and rename behavior were not executed on this Linux host.
