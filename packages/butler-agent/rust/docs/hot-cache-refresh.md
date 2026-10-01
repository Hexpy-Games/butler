# Active-generation hot cache investigation

This is a design proposal and regression record, not an approved implementation.
No production code is changed. The owner must approve refresh ownership and its
relationship to embedding identity before implementation.

## Source design

The TypeScript source was removed at cutover. References below use commit
`37a530825ea1f623184c52a99e6b735edc0da038` (the parent of `f1173515c`).
Paths are relative to `packages/butler-agent/src/agent/cognition/`.

- `memory/scripts/session-sync.ts:137`: for each new transcript chunk, run
  `save_hot.ts`, then index it. No new lines means no save. At line 179 an active
  generation instead takes canonical catch-up and returns without legacy saves.
- `memory/scripts/sync-consumer.ts:507`: legacy queue entries run `save_hot.ts`.
  Lines 869 and 914 advance projection with an **active** target. The consumer
  delays 1.5 seconds after processed work, otherwise polls at 1 second
  (lines 59, 776, 965). These are historical cadence, not a proposed idle timer.
- `memory/projection/ingestion.ts:808`: projection selects a stage. Lines
  831–835 advance the selected hot-cache quantum. Lines 2326–2424 build
  source-backed window summaries, write into `generation.root`, and persist
  receipts/exclusions. Thus active refresh was projection work, not exclusively
  a daily consolidation effect, and was independent of successful embedding.

Current Rust references below are relative to `packages/butler-agent/rust/crates/`.

- `butler-agent/src/host/memory_jobs/daily_schedule.rs:15`: session sync and
  consolidation are once-per-local-day jobs, due at 04:00.
- `butler-agent/src/host/memory_jobs/daily.rs:146`: active session sync calls
  `catchup_once`; only a missing active descriptor runs legacy transcript sync.
- `butler-agent/src/host/memory_jobs/transcript_sync/hot.rs:112`: legacy output
  goes to the memory-root cache or topic files, not the generation cache.
- `butler-memory/src/cognition/completion/consumer/process.rs:155`: the live
  consumer advances semantic projection and vectors, without a cache stage.
- `butler-agent/src/host/memory_jobs/maintain_phase.rs:34`: configured daily
  phases catch up, consolidate the graph, optimize vectors, and refresh health
  and project capsules. There is no generation cache refresh.
- `butler-memory/src/cognition/vector_optimize.rs:36`: `caches_compacted` is
  always zero, retained only for the legacy report; it is not a hidden writer.
- `butler-memory/src/cognition/generation/cache.rs:55`: the available cache
  writer rejects active targets. At line 120 it opens a separate writer, at
  line 126 it reconciles retained cache evidence when idle, and at line 391
  it replaces even unchanged rendered content. Line 428 synchronously fsyncs.
  Merely calling this writer from the live consumer would violate this task's
  performance and shutdown requirements.
- `butler-memory/src/cognition/prompt/memory.rs:112`: the prompt reads the
  generation cache and validates its source evidence at line 165. It does not
  fall back to the legacy memory-root cache.

`HANDOFF.md:86` and `plans/post-0.1.0/02-embedding-model.md:12` identify the
separate embedding identity defect. Neither assigns a Rust active-cache owner.
Historical TS behavior establishes the semantic baseline, but does not settle
the required native ownership, cancellation and bounded-query design.

## Runtime reproduction

`crates/butler-e2e/tests/memory_hot_cache.rs` is the single new stub scenario.
It uses the real executable, an active empty generation, and a loopback model.
A user turn must produce a complete graph summary containing the new fact.
It then drives the first daily maintenance tick by restart at a fixed time after
04:00, waits on persisted job markers, and assembles a turn in another chat.
The assertion expects changed cache bytes and a hot-cache document with the fact.
It deliberately remains a failing regression until an approved fix exists.

Runtime on Linux x86_64, stub tier: the first turn was delivered, and its exact
`conversation_turn:<turn_id>` source had one complete graph summary containing
the new fact. Both daily markers reported `ok`. The other chat's turn was
delivered. The cache remained **12 bytes, unchanged**; actual `source_id=hot-cache`
context documents were **0 before and 0 after**; **2 cache jobs remained pending**.
The expected-freshness assertion failed, after `Scenario::finish` removed the
sandbox. Verdict: **CONFIRMED for missing active refresh**. Runtime observed
successful semantic and daily processing with no cache change; the absent cache
stage as root cause is established by source inspection, not runtime tracing of
every possible writer. The scenario does not test successful vector completion.

The first draft also counted continuity documents under `optional_hot_cache`.
The final scenario filters `source_id=hot-cache` and ties completion to the exact
first turn, avoiding either confounder. No failure was retried to obtain green.
This fixture tests an initially empty cache, not retention of an already valid
migrated cache entry. No owner data folder is inspected. Unchanged real-folder
revisions are consistent with the missing stage; that folder's complete history
cannot be established by this isolated reproduction.

## Options requiring owner approval

1. **Recommended: live projection consumer owns refresh.** Semantic application
   and consolidation emit durable dirty job/entry identifiers, including
   corrections, source revisions and removals. The existing consumer wakes on
   those changes and processes a bounded quantum independently of vectors.
   This most closely preserves TS semantics and cross-chat freshness. It needs
   native dirty-state indexes, fair scheduling and crash-safe receipt handling.
2. **Consolidation-owned batching.** The same dirty work is consumed by a
   background consolidation worker triggered by content changes. Coalescing
   can reduce cache replacements, but adds another owner and increases freshness
   delay. Daily-only execution would regress the TS cross-chat behavior; it
   requires an explicit freshness decision and cannot be sold as an immediate fix.

Both options must satisfy all of the following before implementation is accepted:

- Reuse the existing single graph writer lane, never open another writer.
  Extend its commands to claim dirty work and commit receipts. Validate selected
  generation, source revision and admission again at commit. MIG-01 refusal
  must precede creation of any state, queue, lock or cache file.
- Index dirty/current identifiers. Claim a fixed quantum through indexed seeks;
  retrieve evidence by job/window/source keys. Validate only the retained cache
  entries and changed dependencies, not all projection jobs or all graph nodes.
  Source reads use exact canonical identifiers, never scan the 7 GB BTCC store.
  Consolidation must publish invalidations through the same writer transaction.
- Preserve existing cache admission, ordering, evidence, scope and content
  quality. Do not lower the 20 KiB cache policy or discard facts to meet a budget.
  Drain all dirty work across bounded quanta; completeness assertions must cover
  every eligible result, corrections and removals, not just one marker.
- Hash the complete rendered cache. Equal hash means no cache replacement or
  unchanged receipt rewrite. Changed content gets one owner-only atomic
  `secure_fs` replace; receipts acknowledge only the exact installed hash.
  Recovery must handle replace-before-receipt without rewriting identical bytes.
- Refresh runs after readiness in a cancellable background owner. Turn
  admission, startup and shutdown do not await refresh. Check cancellation
  between bounded operations. Do not launch or join a long fsync on exit;
  cancellation must abandon the quantum for recovery within the 2-second
  shutdown budget. Atomic replace/receipt ordering and filesystem durability
  remain a design decision; cancellation cannot interrupt a blocking fsync.
  In particular, `butler-platform/src/secure_fs.rs:233` currently fsyncs inside
  `replace_private`. Wrapping that call in `spawn_blocking` does not make it
  cancellable. A separately cancellable publication boundary that cannot retain
  the graph writer lane or publish after revocation needs approval and proof;
  neither ownership option alone resolves this hard gate.
- No idle timer runs refresh. With no dirty event, incremental refresh reads
  and writes are **zero**. This fits <=1 MB writes per idle 60 seconds without
  substituting stale output. Startup recovery may use an indexed dirty probe,
  without delaying readiness.

At owner scale (1.6 GB graph, 7 GB BTCC), estimated per-changed-quantum cost is
indexed `O(log N + changed evidence + retained entries)` reads and bounded graph
claim/receipt WAL writes plus one cache replacement of at most the existing
20 KiB policy. Filesystem/WAL amplification is unmeasured, so 20 KiB is a logical
payload estimate, not an I/O guarantee. Neither database size should multiply
the work. There is no BTCC write from refresh. Unchanged content incurs no cache
write. A compliant implementation still needs statement-count/EXPLAIN guards
and full-content stub assertions, then owner-scale read/write, latency and
shutdown measurements in the perf tier.

Open decisions: consumer versus consolidation ownership; freshness/coalescing;
dirty-state indexing and invalidations; existing writer-lane commands; atomic
replacement durability/cancellation; embedding-independent admission and its
coordination with the separately unapproved embedding identity plan.

## Validation

All commands used temporary `HOME` and `BUTLER_DATA`, real cargo/rustup caches,
`-j 8`, and at most one cargo build at a time. E2E used one test thread and the
prebuilt debug agent (`BUTLER_E2E_SKIP_BUILD=1`). Sandboxes were deleted.

- `cargo build --locked -p butler-agent -j 8`: passed.
- `cargo fmt --all`, then `cargo fmt --all -- --check`: passed.
- `cargo clippy --locked -p butler-e2e --all-targets -j 8 -- -D warnings`:
  passed after fixing an unreadable numeric literal in the new scenario.
- `cargo run --locked -p butler-source-check -j 8 -- .`: passed; 2,156 Rust
  files scanned, zero architecture violations.
- `BUTLER_E2E_TIER=stub BUTLER_E2E_SKIP_BUILD=1 cargo test --locked -p butler-e2e
  -j 8 --test memory_hot_cache -- --nocapture --test-threads=1`: failed at the
  expected freshness assertion, after all runtime barriers passed. The first
  draft also failed there; the final run followed the evidence-query correction.
- `BUTLER_E2E_TIER=stub BUTLER_E2E_SKIP_BUILD=1 cargo test --locked -p butler-e2e
  -j 8 --test memory --test memory_idle --test migration -- --nocapture
  --test-threads=1`: passed all six scenarios (1 memory, 3 idle, 2 migration).
  MEM-IDLE measured zero graph commits, zero leases and unchanged graph/WAL/lock
  over 60 seconds. Recovery measured zero idle daily writes and zero subsequent
  writes; changed-source catch-up took 56,892 ms in the existing scenario.

Skipped: live models, owner-folder inspection, owner-scale refresh perf and
shutdown measurements (no refresh implementation), and TS/UI checks (no TS/UI
change). Cache statement-count/EXPLAIN guards and full retained-entry correctness
remain implementation acceptance work, not evidence claimed by this reproduction.
