# Data safety and performance review — 2026-10-02

Reviewed from `53fa0a313` (main after #441/#449), on Linux x86_64/WSL.
Rust/Bun build, test and check invocations used fresh HOME/BUTLER_DATA under TMPDIR, real Cargo/Rustup caches,
release measurement agents, debug agents for fault-injection E2Es,
replay/stub providers, and ephemeral ports. No owner DATA,
installed service, service manager or production model endpoint was used.
The branch is `codex/review-data`; no PR, tag or merge is part of this delivery. Fetching origin during validation found main had advanced to `09ffe9679`
(Windows batch #447). Per this task's no-merge rule, that concurrent batch is
not included in these measurements; integration belongs to the coordinator.

## Findings

Two recurring BTCC queries scaled with **terminal history**, even when there
was no work. Admission runs `waiting_source_sessions` every 500 ms; parent
result maintenance runs `pending_parent_inputs` every 500 ms. Neither had an
index that excluded completed history. A 300,000-row SQLite probe returned
zero rows yet executed 1,200,014 / 900,011 VM instructions respectively.
Partial indexes reduce those to 13 / 10. The indexes are installed at the end
of `T/src/btcc/storage/migration.rs:30`, after old columns and tables migrate,
so old databases without `suspension_reason` remain supported. Terminal rows
are retained in full; no content, ordering or freshness budget is reduced.

The existing idle perf fixture had a large App database and memory graph but
almost no BTCC history. `data_perf` now runs the real service with 300,000
terminal turns/inbox records and 300,000 delivered subsession outbox records in roughly
7 GB of BTCC data, plus 650 historical chats / about 300,000 App events,
2,440 transcript files (about 1.5 GB, largest 290 MB), and 888,000 metric rows
over 300 MB. It checks
all four BTCC row families and reference query plans, unchanged WAL commit/frame counts during a 60-second idle window,
process I/O, complete historical counts and boundary message bodies. It then
measures three complete replay turns, including exact answers and cursor order.

Several authoritative file replacements omitted directory sync, used default
permissions or copied broad legacy permissions. These are fixed below.
Transcript appends now reach `sync_data` before their publication is acknowledged;
new transcript entries also sync the directory. Telemetry remains best effort. Already-private append handles avoid repeated
chmod calls: on this Linux host, chmod to the unchanged 0600 mode still updated
ctime, creating an unnecessary metadata write.

## Measurements and reproduction

The existing PERF-IDLE run **failed** its third physical-read budget. It was
not retried unchanged. The unchanged read/memory budgets and new write assertion
remain enabled; the failure is recorded on [#450](https://github.com/Hexpy-Games/butler/issues/450#issuecomment-5953498050).

| PERF-IDLE interval | RSS B | PSS B | read syscall bytes | storage-read B | storage-write B |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 | 94,785,536 | 90,595,328 | 54,831 | 0 | 0 |
| 1 | 94,560,256 | 90,443,776 | 109,662 | 0 | 0 |
| 2 | 81,481,728 | 77,367,296 | 69,427 | **12,763,136** | assertion not reached |

Intervals 1/2 also include the intervening historical completeness checks,
since the existing fixture carries its last sample across those checks. They
are longer than the nominal 60-second sleep; the unchanged byte budget is thus
conservative. Both preceding complete-history checks passed. The final content
check/write assertion follows the failed read assertion and was not reached.
The mapping monitor stopped before that failed interval. Small read-syscall
bytes plus increased physical reads and falling RSS are consistent with page
fault/reclaim activity, but do not identify the file/subsystem that faulted.
A post-failure host sample had about 8 GiB swap in use and nonzero memory PSI;
this is context, not a demonstrated cause.

The final independent **small-history** WAL scenario passed all three replay
turns, including exact content, complete message windows, cursor order and
latest delivered state. It starts an empty active memory generation and does
not seed owner-scale history; those numbers must not be described as owner-scale
storage performance. The owner-scale scenario failed before readiness in
`PRAGMA quick_check`, so its idle/WAL/cold/warm qualification remains incomplete
([#458](https://github.com/Hexpy-Games/butler/issues/458)). Its actual seeded sizes
were App **1,712,496,640 B**, BTCC **7,644,827,648 B**, transcripts **1,503,903,310 B**
(largest **290,000,815 B**, 2,440 files), and metrics **348,984,000 B** / 888,000 rows.

Each database cell below is **commits / logical WAL-frame bytes**. Frame sizes
include SQLite's 24-byte frame header, exclude the WAL file header, and validate
SQLite's rolling checksum and salts before counting.

| Database | Turn 0 | Turn 1 | Turn 2 |
| --- | ---: | ---: | ---: |
| App | 37 / 1,285,440 | 36 / 1,285,440 | 37 / 1,322,520 |
| BTCC | 37 / 786,920 | 33 / 745,720 | 33 / 737,480 |
| Canonical conversation | 4 / 210,120 | 4 / 189,520 | 4 / 189,520 |
| Session | 1 / 28,840 | 1 / 24,720 | 1 / 24,720 |
| Memory graph | 35 / 688,040 | 24 / 523,240 | 24 / 531,480 |
| **Total** | **114 / 2,999,360** | **98 / 2,768,640** | **99 / 2,805,720** |

| Replay turn | Delivery ms | Process storage-write B | Sampling window s |
| --- | ---: | ---: | ---: |
| 0 | 527.843 | 3,887,104 | 2.537 |
| 1 | 423.763 | 3,821,568 | 2.440 |
| 2 | 538.013 | 3,510,272 | 2.549 |

Mean logical WAL frames were 2,857,907 B/turn and mean process storage writes
3,739,648 B/turn. This is substantial storage work for a short text replay;
App/BTCC/memory account for most frames. The probe does not trace every commit
back to an operation, so those counts do not prove redundant transactions or a
numerical regression from an earlier build. No speculative batching of durable
state transitions was introduced to reduce a metric.

Existing owner-App performance checks also passed on the release build, with
complete responses/counts/order/latest state: first readiness **242.402 ms**,
second readiness **218.932 ms**, empty/owner turn **629.067 / 487.399 ms**,
session-view p50/p95 **7.773 / 9.320 ms**, retention settling **418.622 ms**.
This fixture scales App history, not the 7 GB BTCC table. Transcript backlog
projected 20,472,558 B in **4.293 s**; recorded-offset reopening took **1.079 ms**.


SQLite VM measurements above used an isolated Python SQLite database with the
same schema and queries. The instrumented before/after timings were 425.068 /
0.069 ms (authority) and 155.564 / 0.017 ms (outbox); a callback on every VM
instruction makes these **diagnostic timings**, not a latency benchmark.
The release E2E supplies the actual process-I/O qualification.

The planned cold startup (not reached after the seeded readiness failure) uses a test-support platform adapter to sync and request Linux
`POSIX_FADV_DONTNEED` on this scenario's regular DATA files, including SQLite,
transcripts and metrics. It never drops the host's global cache. This is
advisory **cold DATA**, with a previously used executable and metadata cache;
it is not a reboot/full-machine cold measurement. Warm startup follows the
first settled start without evicting pages.

The WAL probe holds read transactions on App, BTCC, canonical conversation,
session and memory graph databases. This prevents WAL recycling while it counts commit frames
(the nonzero database-size field of SQLite's WAL frame header) and frame bytes.
It verifies the salts stay unchanged once valid frames exist; an empty WAL may initialize a new header. Header bytes are excluded. Counts are actual WAL commit markers,
not `PRAGMA data_version` changes, and bytes are logical WAL frames, not SSD
write amplification. The process's `write_bytes` counter is reported separately. Pinned readers prevent checkpoints from recycling these WALs; that measurement
constraint is explicit. A plain numbers replay is not a tool/subsession-heavy
turn. Non-WAL coordinator/mutation-lock transactions are not counted as WAL
commits; process SSD writes cover the process as a whole. The delivery + two-second
settling window does not claim all asynchronous memory work has completed. No
pre-this-week per-turn commit-counter baseline existed in the
reviewed docs; no unsupported claim of a historical numerical regression is made.

Run from `packages/butler-agent/rust`, after an isolated release build:

```sh
export CARGO_HOME=/home/yeonw/.cargo RUSTUP_HOME=/home/yeonw/.rustup
review_run=$(mktemp -d "$TMPDIR/data-review.XXXXXX")
export HOME="$review_run/home" BUTLER_DATA="$review_run/data"
mkdir -p "$HOME" "$BUTLER_DATA"
export BUTLER_E2E_TIER=perf BUTLER_E2E_PERF=1 BUTLER_E2E_SKIP_BUILD=1
cargo test --release --locked -p butler-e2e --test data_perf -- --nocapture --test-threads=1
rm -rf "$review_run"
```

Each check/test invocation gets its own directory, including formatting,
Clippy and source-check. The idle fixture's **child service** explicitly uses
the stub tier so its loopback-only acquisition hook is honored. Previously,
`Launch::new` inherited `perf` while `assets/background.rs` only honored the
loopback source on `stub`: missing assets could start real downloads in a
synthetic perf test. The unchanged 100 MB and 1 MB/minute idle budgets remain;
the test additionally asserts zero process storage writes. Model acquisition is a separate, intentionally writing startup task, tested by `embed_download`.

## #450 and memory attribution

[#450](https://github.com/Hexpy-Games/butler/issues/450) records one macOS
`ri_diskio_bytesread` spike of 6,176,768 B and a Linux CI maximum RSS of
96,501,760 B. Its earlier macOS result (31,802,160 B) is **physical footprint**,
which excludes clean file-backed mappings; Linux RSS includes those mappings.
Those numbers are not a same-platform memory regression comparison.

The settled Linux mapping sample was 94,740,480 B RSS. Mapping ownership:

| Mapping family | Resident bytes |
| --- | ---: |
| Agent executable (code, constants, relocated globals) | 65,552,384 |
| Anonymous heap/stack/allocator mappings | 24,633,344 |
| System shared libraries | 4,390,912 |
| SQLite shared-memory mapping | 163,840 |

The executable is statically linked with ONNX Runtime; absence of a separate
ONNX `.so` does not mean absence of ML code. A resident-page sample joined
against ELF LOAD segments and demangled symbol ranges attributed approximately
1,477,140 resident symbol bytes to ONNX/native ML/protobuf, 2,690,062 to Butler
memory, 5,089,275 to Gateway/App, 3,173,064 to Turn/BTCC, 3,253,214 to the agent
host, 1,562,569 to runtime, 1,538,541 to model adapters, 1,274,818 to SQLite,
550,544 to vector/storage/tokenizer dependencies and 5,645,174 to async/network.
These are **occupied symbol bytes in resident pages**, not disjoint allocation
sizes: 21,539,474 executable bytes were unassigned constants, unwind data,
padding or symbols outside those ranges. Symbol aliases were deduplicated.
Of the executable mapping, 7,802,880 B was relocated anonymous data; the
remaining 57,749,504 B was file-backed. Anonymous/stack plus relocated executable
data totaled approximately 32,436,224 B, explaining most of the difference
from Linux RSS without equating it to a macOS accounting metric.
Anonymous allocations cannot be assigned to Rust subsystems from `smaps` alone; no unsupported heap-owner claim is made.

All sixteen samples (20-second spacing) found zero child PIDs, including every
thread's child list. After settling, CPU use was 0.239% of one core over 180 seconds. The
parent carries linked ML code/global metadata, but no embedding child/model
session was loaded in this never-used idle fixture. The source admission path
below independently establishes where worker/model initialization occurs.

The embedding owner starts an actor, not a model or child process
(`A/src/host/embedding/owner.rs:67`). `run_item` spawns and initializes the
worker only after a queued embedding request (`owner.rs:323`). The idle actor
parks on notifications/cancellation; ONNX sessions and tokenizers live in the
worker. Assets acquisition checks four paths once on a blocking thread;
it does not load a session. A worker previously used for inference remains
parked for reuse; this review does not claim immediate post-inference eviction.

The missing BTCC indexes explain growing idle reads for installations with
terminal BTCC history. They **do not establish the cause of the particular
macOS spike**, whose fixture lacked that history. The synthetic acquisition
escape is another real source of uncontrolled perf-fixture I/O, but there is
no contemporaneous file-read trace proving it caused that macOS sample.
A native macOS trace during the failed window (including executable/library
page faults, asset staging, SQLite and child PIDs) is still needed. No Linux
cached-read counter can prove the source of macOS physical disk reads.

## Background inventory

Paths below are relative to `packages/butler-agent/rust/crates`:
A = `butler-agent`, G = `butler-gateway`, M = `butler-memory`, R = `butler-runtime`,
T = `butler-turn`, L = `butler-ledger`. Line numbers identify the scheduling
or operation site. “Idle” here means caught up, no due calendar/daily work,
no queued/recoverable operation, no acquisition and no subscribed quota work.
Scheduled/blocked work is disclosed separately; it cannot honestly be described
as universally write-free merely because no human is sending messages.

| Owner / scheduling site | Interval / wake | What it touches and idle reasoning |
| --- | --- | --- |
| A `src/host/service/entrypoint/poll.rs:74` | enqueue notification + 500 ms fallback | Shutdown flag metadata/read if present; processing/pending queue directories; BTCC authority waits. Completed/failed queue folders are not inventoried. Empty directories and new partial waiting index bound reads; no write without a claim/recovery. Deferred pending records are an exception below. |
| A `src/host/service/entrypoint/maintenance.rs:23` | 500 ms | Progress events use `idx_btcc_progress_events_pending_page`; parent results now use the pending-outbox partial index. No transcript/mark-published/delivered write when results are empty. |
| A `src/host/memory_jobs/sync.rs:156` | notifications; 1,2,4,…30 s idle, capped at next 60 s catch-up; ≤5 s deferred | Descriptor/manifest and fixed graph probes. Long-lived read-only graph connection, indexed due windows/vector/cache jobs. No lease/graph commit without work. |
| M `src/cognition/completion/consumer/catchup.rs:45` | 60 s admission deadline | Canonical identity/revision/cursor checks; unchanged inventory skips outcome/message pages. Source revisions, changed identity or unclean recovery cause bounded catch-up. |
| M `src/cognition/completion/consumer.rs:291` | 2 s watch slice while sleeping | Queue metadata/notifications; wakes on changed queue, does not repeatedly parse an unchanged queue. |
| A `src/host/memory_jobs/context_maintenance.rs:68` | immediate first tick, then 60 s | Timezone + three small daily markers. Before due/already attempted: no writes, no metric/transcript reads. At 03:30 pruning/metrics retention, at 04:00 session sync/consolidation intentionally work and write markers. Marker I/O now uses blocking workers and durable private replacement. |
| G `src/gateway/application/retention.rs:336` | 25 ms semantic / 5 ms maintenance **only with work** | Startup/terminal-turn sweep pages, projections, sweep watermark and passive checkpoint after 1,000 deletes. When settled, parks on commands/event cursor; neither timer is selected. |
| G `src/gateway/application/projection/owner.rs:224` | native filesystem notification; retry only while work pending | Transcript appended-byte ranges/checkpoints, terminal projections; no idle sweep. Open-turn inventory occurs once at startup. Notification overflow resweeps, keeping complete content. |
| G `src/gateway/application/storage.rs:298` | 6 h, busy-lane retry 60 s | `PRAGMA optimize`; SQLite's changed-table/statistics admission, analysis_limit=1,000. Can update statistics after data changed. This is bounded planner maintenance, not an unconditional database rewrite. Not exercised across six hours here. |
| G `src/gateway/application/queue_dispatcher.rs:187` | earliest admitted retry deadline / queue notification; no deadline with empty queue | Indexed pending App queue head, executor readiness and retry eligibility. Due queued work can dispatch/write; no recurring timer when empty. |
| G `src/gateway/application/automations/scheduler.rs:47` | exact next due time or mutation notification; indefinite wait with no schedules | Indexed next-due schedule lookup once per change/wake; writes only dispatch/recovery of due work. Existing 60-second idle scheduler E2E checks one lookup. |
| G `src/gateway/application/quota_events.rs:65` | 30 s, provider due interval 5 min | In-memory subscriber count; no poll without a connected App event stream. Connected quota polling uses provider network/auth/cache and changed quota events can write SQLite. Explicitly disabled in synthetic idle tests. |
| A `src/host/app/monitoring/quota.rs:99` | request/change-driven task; explicit wait ≤25 s | Provider quota I/O, never an independent daemon timer. |
| G `src/gateway/live.rs:240` | 15 s, only open SSE stream | Network heartbeat and in-memory state, no DATA writes or file reads. |
| A `src/host/embedding/owner.rs:269` | queued request / cancellation / child exit | No model or worker at never-used idle. Existing worker waits on pipe/process events; no disk loop. |
| A `src/host/embedding/worker/assets/background.rs:57` | one startup acquisition, explicit retry | Four model paths, staging/lock/download files. Blocking task; existing complete assets only metadata/cleanup. Missing assets intentionally write while downloading, then task exits. No periodic re-download. |
| A `src/host/app/runtime_ports/setup/readiness.rs:95` | progress watch notifications | In-memory setup view relay. Its preparation task runs once/retry, then exits; executor check polls 100 ms only until ready. DATA writability probe is temporary first-run work. |
| G `src/gateway/wallpaper_modules/watch.rs:92` | native watch; 250 ms quiet debounce, ≤2 s burst | User module paths; no timer until a change arrives, no disk writes in debouncer. |
| A `src/host/app/gateway_lifecycle/control.rs:157`, G `src/gateway/http/start.rs:17` | socket accept | No timer/file I/O when parked. Per-request tasks are demand-driven. |
| A `src/host/service/entrypoint/stop_signal.rs:68` | OS shutdown signal | Parked receiver; watchdog's 30 s sleep is created only on stop. |
| A `src/host/service/conversation_observer.rs:54`, `src/host/guided/work_streams.rs:60`, G `src/gateway/transcript.rs:40` | channel receive on owned threads | Completion notices, Work JSON, transcript append only after a command. No idle receive timeout/write/scan. |
| G `src/gateway/application/storage.rs:58`, T `src/btcc/storage.rs:130`, conversation/session lane owners | blocking channel receive | SQLite owners perform jobs only when submitted. The service polls above account for recurring jobs. Closing/joining tasks perform work only on close. |
| G automation owner, session/project/branch/queue mutation owners; L project work; M registration/recall; R tool-output | channel/admitted operation | Owners block on receive or exist only for an admitted command. Bounded queues/semaphores do not themselves perform disk I/O. No separate recurring timers were found. |
| R `src/operations/update/status.rs:87` | stale status request triggers one task | Saved update JSON/manifest/staging; no independent periodic updater. |
| T `src/workspace/session_worktree.rs:190` | native filesystem watcher | Reacts to workspace changes; no idle whole-tree polling. |
| Model MCP SSE reader / source relay | network/stdout receive | Network pipe wait, no DATA poll or append without incoming/requested work. |

Transient timers/pollers, **not running in a settled idle service**:

| Scheduling site | Interval / deadline | Touches |
| --- | --- | --- |
| A `src/host/embedding/worker/assets.rs:172`, `assets/download.rs:48` | lock wait 500 ms; retry 1,2,4 s | Asset lock/staging/network only during acquisition. |
| A `src/host/service/restart_handoff.rs:45,69` | 25 ms | Admission lock/control publication only during restart. |
| A `src/host/service/instance/record.rs:139,161` | injected hold; 10 ms release probe | Stub shutdown fault only. |
| A `src/host/app/server/startup_hold.rs:20`, `src/host/service/entrypoint/poll.rs:172`, `src/host/memory_jobs/sync.rs:143` | 10/10/20 ms | Explicit stub startup barriers only. |
| A `src/host/cli/service/lifecycle/readiness.rs:76,106,131,229,246` | 100 ms | Instance/endpoint/stop-intent while CLI start/restart waits, not a daemon loop. |
| A `src/host/cli/service/lifecycle.rs:294`, `lifecycle/stop.rs:181`, `supervisor.rs:172` | 25 ms / 50 ms / 25 ms | Lifecycle admission or process exit while a CLI action is pending. |
| A `src/host/cli/service/lifecycle/managed.rs:65`, `supervisor.rs:76` | 1 s startup grace; bounded crash backoff | Supervisor process status and owned child launch only. |
| A `src/host/cli/gateway.rs:38`, `remote/pair.rs:47`, `oauth_login.rs:195`, `app/runtime_ports/setup/oauth.rs:261` | 200 ms / 1 s / 3 s / flow timeout | Explicit gateway, pairing and OAuth operations; no idle invocation. |
| A `src/host/cli/observability/logs.rs:131` | 500 ms default; ≥10 ms override | Explicit `logs --follow`: follower seeks appended bytes, unchanged files only stat; no writes to DATA. |
| A `src/host/memory_jobs/transcript_sync.rs:266` | 120 s | Deadline for admitted legacy transcript sync only. |
| G `src/gateway/application/wallpapers/modules.rs:300` | bounded checker poll | Explicit wallpaper import shader subprocess. |
| M `src/coordination/coordinator.rs:137,144` | requested lease deadline/backoff | Coordinator SQLite/lock acquisition only for actual writes; idle probes do not acquire it. |
| M `src/cognition/vector_optimize.rs:90` | supplied deadline | Explicit index optimization operation. |
| R `src/context/compaction/storage.rs:103` | 25 ms contention backoff | Compaction owner opening under contention. |
| R `src/web_access/read/fetch.rs:47`, `read/lightpanda.rs:172,193` | 20 s / supplied deadlines | Requested network/reader subprocess only. |
| `butler-models/src/models/request_guard.rs:104`, `models/transport.rs:290` | request deadline / retry delay | Active model request only. |
| T `src/btcc/model_route/routed/recovery.rs:189`, `agent_loop/stream_relay.rs:125` | recovery delay / coalescing window | Active route recovery or streaming event, no idle Turn. |
| T `src/workspace/commands/guided.rs:243`, `commands/structured/supervisor.rs:49,62` | command deadline / 10 ms active process probe | Explicit command subprocess only. |
| G `src/gateway/transcript.rs:132` | close grace | Close receipt timeout, never an idle wake. |
| M `src/cognition/lance_store.rs:36` | ZERO read-consistency interval | A freshness check on a requested Lance read, not a spawned poller. |

This inventory combines `interval`, `interval_at`, `sleep`, `sleep_until`,
`recv_timeout`, `timeout`, thread/task spawns and native watchers across all
product crates. Test-only loops and platform socket/process readiness adapters
are not product disk pollers. Event-driven finite work and close tasks are
accounted for as groups rather than misleadingly calling them periodic jobs.

## Atomic-write and privacy coverage

`butler-platform/src/secure_fs.rs:253` is the shared contract: unique sibling
`create_new`, owner-only mode where supported, complete write, file sync,
platform rename, directory sync. Failure before rename preserves the old file;
failure after rename may mean the new value is already published. A power cut
can leave an unpublished private temporary file. Atomic replacement is not a
cross-file transaction; callers' queues/receipts/leases provide recovery.

| File family / entry point | Reviewed behavior |
| --- | --- |
| Core config / G settings / model registrations — `butler-core/src/configuration.rs:129`, `butler-models/src/models/configuration/settings.rs:278`, `mutations.rs:270` | Shared replace_private. Registration previously used fs::write + rename, with default mode and no sync; fixed. |
| Provider credentials, file secret backend, local agent/admin credentials, OAuth profile | Existing shared private replacement; OS credential stores use their native API. Custom model bearer JSON (`local_credentials.rs:37`) previously omitted directory sync; fixed. Multi-file registration is still not a single transaction. |
| Instance record — A `src/host/service/instance/record.rs:36` | Retains existing unique private temporary + file sync + shutdown fault hook, adds platform rename + directory sync. |
| Stop intent / nonce shutdown flag — A `src/host/service/instance/stop_intent.rs:147`, `delivery.rs:70` | Now shared durable private replacement; no truncated nonce can become an unscoped shutdown request. |
| Executor readiness / startup grace / session pointer — R `src/operations/service_readiness.rs:23,83`, A `src/host/service/configuration/session.rs:166` | Shared durable private replacement. Previously unsynced rename or in-place fs::write; fixed. These remain identity-checked/ephemeral lifecycle records, not proof a PID is live after reboot. |
| Daily markers — A `src/host/memory_jobs/context_maintenance.rs:227`, `daily_schedule.rs:81` | Shared private replacement, directory sync; context marker operations moved off Tokio workers. Small read state is bounded by the writer's schema. |
| Work-stream/TODO state and generated artifact publication — A `src/host/guided/work_streams/support.rs:414`, `command/artifacts.rs:251` | Shared private durable replacement. Former ad hoc JSON/artifact rename omitted sync. |
| Active generation hot cache / audit — M `src/cognition/generation/cache/publication.rs:172,185` | Shared private replacement, with data-authority checks before publication. Audit is private append; existing audit mode is restricted on open, and creation now syncs its parent. |
| Legacy global/topic hot cache — A `src/host/memory_jobs/transcript_sync/hot.rs:186,237`; M `src/cognition/hot_cache/import.rs:240` | Global rename now directory-synced without copying broad prior permissions; topic markdown keeps private append under its existing lock, now file/new-parent synced. Import rename also syncs directory. Topic append is an explicit crash-tail exception: a power cut can leave partial markdown. Whole-file replacement would make each append rewrite growing history and is not used. |
| Legacy vector stats and session offsets — M `src/cognition/hot_cache/receipts.rs:187`, `legacy/session_sync.rs:104` | Shared replacement, no broad permission copying, directory sync. Provenance/memory logs remain append-only. |
| Memory maintenance summaries, completion dead letters, capsule failure logs, legacy provenance/diagnostics, typed-source journals — M `src/cognition/configured_cycle.rs:276`, `completion/consumer/process.rs:315`, `project_capsule/write.rs:104`, `hot_cache/receipts.rs:224`, `legacy/session_sync.rs:189`, `sources/typed/write.rs:295` | Shared private no-follow append opener, including restriction of broad legacy file modes. Maintenance summary and completion dead-letter creation previously used default modes. Diagnostic append tails remain best effort; typed journals retain their existing file/new-parent sync. |
| Imported-session marker — M `src/cognition/legacy/memory_import.rs:158` | Private no-follow append; now file-synced and new-parent-synced before returning. Line framing and idempotent source imports provide replay, rather than pretending an append is atomic replacement. |
| Active descriptor, generation manifest/embedding binding, box manifests/index JSON, typed source, briefing, feedback, know-how, observation notices | Existing shared replacement or private create_new + sync + rename + sync_path(parent), protected by data authority/lease. Generation directory publication and indexed stores use their own staging/transaction protocol. |
| Cognition namespace migration manifest — M `src/cognition/migration/plan.rs:265` | Shared durable private replacement with authority checks. Previously truncated in place, which could destroy the recovery manifest on interruption. |
| Embedding digest cache — M `src/cognition/embedding/assets.rs:130` | Replaces predictable File::create temp with shared private replacement. A rebuildable cache write can fail harmlessly; full digest verification still occurs when needed. |
| Completion sync queue — M `src/cognition/completion/queue.rs:60,160,245` | Idempotent JSONL append under lease, file + new-parent sync; removal uses private replacement and directory sync. SQLite queue mode uses SQLite transactions. |
| Transcripts — G `src/gateway/transcript/file.rs:11` | Private no-follow append, sync_data before acknowledgement, directory sync on creation. Complete outbound/delivery pair serialized into one byte buffer. Append streams are not replacement files; readers/recovery use framed records and canonical durable facts. |
| Compaction evidence — R `src/context/compaction/storage.rs:14` | Private no-follow append, legacy mode restriction, file sync and new-parent sync. A complete JSONL record is serialized before writing. Former append lacked sync/no-follow and did not repair existing modes. Append can still leave a crash tail; it is not atomic replacement of authoritative SQLite compaction state. |
| Metrics — R `src/operations/metric_files.rs:75,107`, `prompt_metrics.rs:55`, `web_search_metrics.rs:101` | Private no-follow append, existing open-file mode restricted; retention keeps owner-only replacement mode and now syncs its directory. Former append default mode and retention permission copying were fixed, including web-search events. Telemetry append is intentionally not fsynced per record and may lose a crash tail. |
| Developer log — R `src/operations/developer_log/store.rs:104,198` | Existing owner-only no-follow append; retention syncs private output, now platform-renames and syncs directory. Best-effort append tail, not an authoritative journal. |
| CLI/supervisor logs — A `src/host/cli/service/lifecycle.rs:371` | Shared private no-follow append opener now repairs broad legacy log modes. Output relay is demand-driven and best effort. |
| Command/web/image spools, diagnostic bundle, locks | Private create/open where they can contain user output; append/streaming artifacts intentionally differ from replaceable state. Lock contents are advisory and process identity is independently verified. |
| Downloaded model/update/skill/wallpaper trees, projection byte spools | Staging then validated publication or reconstructible append/cache. Public distribution/model bytes do not contain owner secrets. Tree/SQLite publication is not equivalent to a single-file replace. Existing durable-files E2Es exercise interrupted multi-step publication. |
| Authorized user workspace and Project Ledger materializations | User-facing file semantics/permissions and staged project publication; workspace mutation writer uses sibling staging. These are separate from private agent configuration and must not silently force all owner source files to mode 0600. |

Privacy capability is platform-specific: Unix supports owner-only mode and
parent fsync. Windows private directories use current-account/system ACLs
and inherited file protection; per-file modes, no-follow opens and directory
sync remain unavailable there (`secure_fs/windows.rs:1`). Existing directories
need the DATA protection contract; creation alone does not repair their ACLs.
This Linux run does not qualify Windows/macOS crash behavior. No process-level test simulates hardware power loss; file and
parent sync ordering is established by the implementation/shared contract.
That contract syncs the containing directory; durability of newly created
ancestor-directory chains is not separately power-loss qualified here.

## Startup readiness and blocking work

The final owner-scale startup failed the unchanged **90-second** deadline.
Finer trace isolates the operation, rather than attributing it to cutover:

```
14:46:02.819 [btcc-startup] phase=activated_begin elapsed_us=6
14:46:02.820 [btcc-startup] phase=schema_validated elapsed_us=1613
14:47:32.813 native_service_start_timeout
```

`T/src/btcc/storage/bootstrap/validate/activated.rs:34` calls `integrity` next;
`bootstrap/validate.rs:44` executes `PRAGMA quick_check`. It did not finish
before the deadline; there was no `integrity_validated` or reference-check phase.
The observed interval in that stage is approximately 90 seconds, not a measured
completion time. This is a blocking **read-only** full-database integrity check
on a blocking worker, before any BTCC migration/cutover or runtime owner opens.
It remains enabled. Schema/reference/integrity rejection was not weakened.
The cause of its throughput on this shared host is not established by phase
logs alone. An issue was filed after searching matching open issues:
[#458](https://github.com/Hexpy-Games/butler/issues/458).

| Runtime phase | Small-history ms | Seeded owner-start ms |
| --- | ---: | ---: |
| Configuration/model adapters | 5.524 | 9.604 |
| Memory preflight | 0.162 | 3.433 |
| Skills | 1.097 | 1.971 |
| Canonical stores | 222.261 | did not finish before 90 s |
| Defaults/observer/memory consumer | 2.071 | not reached |
| Profile | 4.618 | not reached |
| Runtime ports | 0.113 | not reached |
| Admission | 6.749 | not reached |
| Executor durable publication | 7.681 | not reached |
| App gateway | 21.752 | not reached |
| Dispatch recovery/instance readiness | 3.786 | not reached |

The small-history phase trace has separate clocks for runtime opening
(235.847 ms total) and serving (39.969 ms); it does not include every
pre-runtime process/credential/listener step. **Warm/cold readiness at full
BTCC owner scale was not qualified**: the seeded first start failed, so the
later starts, six-index plan/content assertions, exact idle window and owner
WAL measurement were not reached. The cold scenario's DATA eviction and index
migration assertions remain in the test with the original readiness deadline.
First creation of all six indexes on an older deployed database is also not
qualified: the scenario drops only the two poll indexes for its planned cold
start, while the other indexes already exist from initial fixture startup.


A separate confirmed startup hydration defect was also found in
`T/src/btcc/storage/legacy_cutover/support.rs:152`: `load_turns` selected and
collected every full original message before deciding whether any legacy
migration was needed. In the adversarial fixture, those strings alone total
6,900,000,000 B; this is a logical content-volume calculation, not a measured
heap peak. The earlier owner-scale starts timed out at the unchanged 90-second
service deadline, including a valid inbox/relation fixture. Those coarse traces
stopped inside canonical store opening. The final finer trace shows that this
fixture is blocked by the preceding integrity check; hydration was a proven
additional history-dependent allocation, not the proven cause of the observed
90-second deadline failures.

Cutover now selects only non-R3/unknown states plus admitted turns with legacy evidence, using an indexed candidate set. Evidence drives correlated primary-key state
lookups; an ordinary JOIN instead chose a full Turn scan in the SQLite probe,
so that accidental history scan is also avoided. Missing evidence targets are still
checked by Turn primary-key lookups, and unsafe admitted reentry/unknown states
still quarantine. Completed R3 history is retained without hydrating message
bodies into a migration vector. Existing cutover/race tests remain required.
The candidate predicate also includes NULL state in malformed legacy schemas:
the existing decode error must remain a startup rejection, rather than silently
filtering that row out. The existing cutover race test now exercises this case.


Memory fresh-generation preflight runs in spawn_blocking and checks descriptors
and occupation, without opening model sessions or scanning graph rows. Fresh
initialization is handed to the memory-sync task; the foreground need not wait
for model assets or optional vector projection. The current active generation
is validated before use. Model acquisition runs separately on a blocking task
and updates an in-memory progress watch; the four-path availability check does
not hash/read a 587 MB model on the readiness path.

Three nullable-reference startup checks also walked all terminal turn rows.
The same 300,000-row probe took 900,014 VM instructions per check with zero
non-null references, versus 17 with covering partial indexes. The checks still
validate every non-null reference against its target; missing targets are not
ignored. Initial index creation is a one-time migration cost.

SQLite schema/index creation and bounded startup `PRAGMA optimize=0x10002`
run on the dedicated SQLite lanes. **First creation of the new partial indexes
still reads historical table rows once, before readiness**, and can be large;
the perf scenario drops both poll indexes before its final cold owner-scale
start to measure that migration, then verifies complete persisted content. Deferring
that required migration while continuing unindexed 500 ms polls would hide
rather than fix the root cause. No startup deadline or content was weakened.
The executor/grace publication now runs on a blocking worker as well, so its
new durability syncs do not occupy a Tokio worker.

## Limits and follow-up

* The Linux PERF-IDLE third-window physical-read failure and macOS #450 remain unattributed; native failed-window trace and same-build
  footprint/mapping/child samples remain owner-machine work. No service was
  touched on this host. A comment is added to the existing issue, not a duplicate.
* A `src/host/service/ingress.rs:247` / G
  `src/gateway/inbound_queue/storage/claim.rs:38` still enumerate and parse
  **blocked pending** records each fallback poll. Settled terminal history is
  excluded, but a large blocked queue is not proven read-bounded. This review
  does not disguise blocked pending work as the quiescent fixture.
* Legacy topic markdown can retain a partial append after a crash
  (`A/src/host/memory_jobs/transcript_sync/hot.rs:237`); private mode and successful
  append durability are fixed, but no transactional topic journal was introduced.
* Daily retention reads metric files and legacy sync reads newly available
  transcript ranges when due. Scheduler marker writes are intentional;
  absolute “zero writes forever, even with a due schedule” is not the current
  product contract (`A/src/host/memory_jobs/context_maintenance.rs:68`).
* The six-hour optimize path is reviewed statically, not sampled for six hours
  (`G/src/gateway/application/storage.rs:298`).
* Full BTCC owner-scale cold/warm startup, idle I/O and WAL qualification remain
  blocked by #458 (`T/src/btcc/storage/bootstrap/validate.rs:44`,
  `tests/data_perf.rs:41`). Neither the required integrity guard nor the original
  90-second readiness deadline was relaxed.
* Per-turn counts are a reproducible new small-history baseline for the three replay turns,
  not a comparison to an unmeasured older build. Tool-heavy/subsession turns
  remain a separate storage-amplification measurement (`tests/data_perf.rs`).

## Validation

Commands were run sequentially with a fresh HOME/BUTLER_DATA per invocation; Cargo used `-j 8`, functional E2Es four threads and resource E2Es one thread.
No test was retried unchanged to obtain a pass.

| Check / test | Result |
| --- | --- |
| `cargo fmt --all -- --check` | PASS |
| `cargo clippy` on Agent, Gateway, Memory, Models, Runtime, Turn, Platform and E2E, `--all-targets -- -D warnings` | PASS |
| `cargo run --locked -p butler-source-check -- .` | PASS: 1,792 modules / 47 domains; zero shape, platform, test-ratchet, architecture or E2E-gate violations. Existing size baselines only shrank. |
| Bun 1.3.11 `install --frozen-lockfile --ignore-scripts` | PASS: 1,605 packages, 4.60 s |
| Bun 1.3.11 `run check` | PASS, including the final workflow change |
| Release Agent build / debug fault-injection Agent build | PASS. A pre-existing release-only `unused_mut` warning remains at A `src/host/service/ingress/bind/policy.rs:307`; debug Clippy has no warnings. |
| `app_storage_scale`, `projection_backlog`, `btcc_cutover`, release agent, budgets enabled | PASS: 1 + 3 + 1 tests |
| `idle_resources`, release agent, perf tier | FAIL: third physical-read interval, recorded on #450; not retried unchanged |
| `data_perf`, release agent, perf tier | 1 PASS (small-history WAL) / 1 FAIL (owner startup inside quick_check), tracked as #458; downstream owner measurements not reached |
| Seven product crates' `--lib` tests | PASS: Agent 39, Gateway 45, Memory 117, Models 65, Runtime 72, Turn 110 = 448. Platform has zero lib tests on this host. The pre-existing ignored MCP stdio fixture child is invoked explicitly by its parent tests; no new ignore was added. |
| Platform `contract` secure-filesystem tests | PASS: 20 contract tests, including private replacement, legacy-mode repair/no-follow append, lock/process behavior and temporary file secrets; system secret-store access explicitly disabled. Platform lib and feature-enabled lib builds passed with zero lib tests. |

Functional E2Es used the debug agent for existing fault hooks and the ordinary
stub tier (`BUTLER_E2E_PERF=0`); this is functional validation, not a claim of
perf-tier latency qualification. All **55 tests / 18 binaries passed**:

| Binary | Passed | Binary | Passed |
| --- | ---: | --- | ---: |
| btcc_cutover | 1 | cli_surface | 1 |
| credentials | 3 | durable_configuration | 1 |
| durable_files | 8 | embed_download | 6 |
| legacy_import | 1 | lifecycle_intent | 6 |
| memory_hot_cache | 1 | memory_idle | 3 |
| migration | 2 | queue_admission_shutdown | 1 |
| queue_shutdown | 1 | schedules | 4 |
| setup_local_models | 6 | shutdown_order | 6 |
| shutdown_wal | 1 | startup_readiness | 3 |

Additional functional evidence: memory idle over 60.001 s produced zero graph
commits, unchanged graph/WAL/lock bytes and zero leases; crash recovery reported
zero daily/further writes. Active-turn plus queued-follow-up shutdown/restart
completed in 2.189 s with content recovery. The shutdown-WAL scenario retained
all 73,533,792 B, closed in 103.076 ms and restarted in 346.283 ms. The deliberate
stalled-startup test exited at 89,897 ms and released its port.

Initial fixture construction exposed missing foreign-key/parent records, which
were corrected; no fixture row counts/content were reduced. Owner startup then
failed its original 90-second deadline before and after the cutover hydration
fix. Finer diagnostics were added to locate that remaining failure. A compaction
writer import error and an unused import were caught and fixed before the final
build/checks. No timeout, performance budget or integrity check was relaxed.

CI was not re-run and no PR was opened: the coordinator owns the batched PR/CI. The worktree build target is deleted after validation, as requested.

