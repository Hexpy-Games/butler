# After 0.1.0 (ordered by impact)

The summaries are in `HANDOFF.md` §4. The per-item status and file:line references are in the bodies of the draft PRs listed below. Before starting an item, write it up as a plan file in this folder.

| # | Item | Start from | Suggested model |
|---|---|---|---|
| [ ] | P1 BTCC storage | `origin/main` | sol medium |
| [ ] | P2 Memory vector identity bug, plus memory idle loops and Lance maintenance; embedding model: see [02-embedding-model.md](02-embedding-model.md) | `claude/perf-memory` (draft) | sol medium |
| [ ] | P3 Projection follow-up | #319 (draft, rebase after #318) | luna max |
| [ ] | P4 App storage and read path | `claude/perf-app-storage` (draft) and the gateway audit (HANDOFF §4.4) | sol medium |
| [ ] | P5 Turn hot path | `claude/perf-turn-hot-path` (draft) | sol medium |
| [ ] | P6 Idle loops | `origin/main` | luna max |
| [ ] | P7 Perf CI tier | `origin/main` | sol medium |
| [ ] | P8 Release profile | `origin/main` | luna max |
| [ ] | P9 Windows completion | `origin/main` | sol medium |
| [ ] | P10 Follow-ups | `origin/main` | luna max |

Preview decisions and partial implementation evidence are listed in [the 2026-10-02 Ledger publication queue](../ledger-updates-2026-10-02.md). In particular, fresh memory bootstrap, hot-cache refresh and compatible vector identity adoption are on main; P2 remains open for its other acceptance items. P9 remains Windows installer/completion work.

What each item covers:

- **P1 BTCC storage**
  - `btcc_model_round_acceptances` keeps only the latest continuation per turn: 5.9 of 7.1 GB, O(n²).
  - Gate the startup `quick_check` (23 s).
  - Move tool-call delivery state to a side table.
  - Add progress-events retention.
  - Filter operation-output reads in SQL.
- **P2 Memory**
  - Compatible serving identity adoption is merged (#445); retain verification of remaining identity and catch-up cases.
  - Catch-up wrap-around.
  - The `pending_semantic_job` query.
  - Idle leases.
  - Lance compaction, version cleanup and indexes.
  - Embedding batching and cache.
- **P3 Projection follow-up**
  - Batching.
  - Replace the base64 encoding.
  - Throttle.
  - Read-only UI connection.
- **P4 App storage and read path**
  - Publish after commit.
  - Read pool.
  - `/work-status` lean query.
  - Remove the worker-activity N+1.
  - Cache skill names.
  - Incremental prompt-log index.
  - Store computed progress rows.
  - No writes on GET.
  - ETag and gzip.
  - Events retention (owner decision; 30 days proposed for replay-only events).
- **P5 Turn hot path**
  - Per-message token and serialization cache.
  - Admission fast path.
  - HTTP client tuning.
  - Anthropic streaming and `cache_control`.
  - MCP session pool.
- **P6 Idle loops**
  - Ingress poll.
  - Metrics admission counters and retention.
  - Developer-log rotation.
  - Quota config caching.
- **P7 Perf CI tier**
  - Owner-scale seed.
  - Idle CPU, footprint, disk and wakeups.
  - Startup time.
  - Endpoint p95 and SQL statement budgets.
  - n-vs-4n scaling test.
- **P8 Release profile**
  - Strip symbols, LTO, `codegen-units=1`.
  - Evaluate mimalloc.
  - Evaluate splitting a memory-worker binary.
- **P9 Windows completion**
  - Task Scheduler.
  - `butler.exe` shim.
  - PowerShell installer.
  - Read-only command sandbox.
- **P10 Follow-ups**
  - Issues #311, #312, #314, #226, #218, #272, #293.
  - Port `/space/branch-source`.
  - T2 test cleanup.
