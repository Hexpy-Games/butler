# Work-model core implementation evidence

This records the phase 1 implementation and local validation of the
`codex/work-model-core` row in [the binding design](work-model-design.md#9-implementation-branches-and-acceptance).
It is an evidence report, not another implementation checklist. The design's
later instruction, replan, control, migration, view and acceptance rows remain
separate deliveries. Validation used Linux x86_64 WSL on 2026-10-03, stub/replay
models only, fresh temporary `HOME`/`BUTLER_DATA`, Cargo `-j8`, and at most four
E2E threads (one for the resource fixture). No owner installation was accessed.

## Delivered behavior

`BUTLER_WORK_MODEL=core` enables the new mode on a new/empty installation.
Populated legacy BTCC or Ledger work stores refuse enablement. A durable
`work-model-core-v1` writer marker refuses startup without the mode after cutover.
The default continues to use the existing tools, writer and scheduler paths.
Migration and default-on rollout are deliberately unavailable in this phase.

The existing direct/delegate router supplies Tier 0/1/2 without an additional
classification call. Tier 0 creates no managed Spec, Plan, Work or Task. Tier 1
creates one brief with two or three criteria and at most five Tasks in one
bootstrap operation, without a Spec approval ceremony. Tier 2 requires a
recursive initial Spec tree before delegation. A lower-tier delegation attempt
is held with the replan-unavailable reason rather than bypassing the tier floor.

Immutable Spec revisions are published through Project Ledger; SQLite stores
verified hashes, references, tree membership, selected pointers and criterion
indexes rather than another editable Spec body. Publication precedes atomic
Plan/Work/Task activation. Publication intent, stable derived IDs, payload hashes
and durable receipts recover a crash without a second active graph or duplicate
document. Inactive published candidates remain inspectable. Both Ledger CLI
implementations reject mutation of the managed immutable namespace.

Plan, Work and Task creation requires node/part/criterion bindings and validates
the entire initial dependency DAG. Task IDs survive reordering and cancellation.
Fan-out can run independently; a join cannot start until predecessors complete.
Sparse edits preserve unspecified cards and history; removing a pending Task
retains its tombstone and requires explicit incident-edge rewiring. Completed
Tasks are immutable. Execution leases and effect admission pin the canonical
Task, Plan/tree version and Spec revision/hash. Existing effect authority still
applies; an admitted in-scope creation request adds no approval prompt.

Submission retains immutable result/evidence references and enters review.
Completion requires an exact, current result/Spec criterion review; a free-form
approval, missing criterion, failure or unverified result cannot complete it.
Work/Plan completion also requires contributing child coverage and independent
parent integration criteria. A null research result can satisfy the predefined
method without manufacturing support for its hypothesis. Delegation and nested
Workers use one canonical Task/Plan; child delivery does not fabricate an
accepted legacy Work review or imply managed Task completion.

Authenticated reads expose `GET /sessions/{id}/work-summary` (50 cards),
`GET /plans/{id}/task-graph` (500 nodes), and
`GET /sessions/{id}/work-spec?node_id=...` (the exact node and ancestors).
Keyset cursors are revision-bound, totals include retained items, and historical
Plans remain addressable. Mutations use `POST /sessions/{id}/work-model` or the
narrow `work_apply` tool; `work_read` supplies Summary/graph/Spec reads.

Core queue dispatch, BTCC maintenance and projection delivery wake on actual
changes or pending deadlines. Platform-owned filesystem notification ignores
read-access events; a Core transcript read cannot enqueue another transcript
read. The legacy projection callback and timer paths retain their existing
behavior. Memory-only observation counts actual BTCC SQL statements and queue
scans without logging SQL or credentials.

## Acceptance and regression evidence

All production E2Es use public gateway, tool and Ledger paths. Existing test
fixtures cover the shared role/phase wire surfaces without increasing the
non-E2E test-count ratchet.

| Run | Result |
|---|---|
| Initial release `work_model`, with `BUTLER_E2E_TIER=stub BUTLER_E2E_PERF=1`, one thread | 19 passed, 0 failed/ignored; 280.19 s |
| Expanded full release suite before fixture syncing | 19 passed / 1 Spec-latency failure; 187.35 s; all 18 functional cases passed |
| Final release `work_model wm_13`, with durable fixture and both activation gates | 2 passed, 0 failed/ignored; 342.46 s; all budgets enforced |
| Focused immutable Ledger CLI/unpublished/foreign-reference E2E | Passed; 1.95 s |
| Debug `work_model wm_15_recursive_coverage`, after its assertion helper cleanup | 1 passed; 2.98 s |
| Debug existing-path regression targets listed below, four threads | 32 passed, 0 failed/ignored |
| Rust library tests: Agent, Gateway, Ledger, Platform, Turn, four threads | 198 passed (39/45/4/0/110); child-process format-pin self-checks passed |
| `cargo fmt --all` | Passed |
| Clippy on Platform, Turn, Ledger, Gateway, Agent, E2E, Source Check; all targets, `-D warnings` | Passed |
| `cargo run -p butler-source-check -- .` | Passed; function/platform/test/architecture/E2E gates all zero violations |
| Bun 1.3.11 `install --frozen-lockfile --ignore-scripts` and `bun run check` | Passed |
| Existing Ledger CLI/publication/authority/bounded-I/O Bun tests | 51 passed, 0 failed, 745 expectations; 7.13 s |

The regression targets were `cli_surface` (1), `durable_configuration` (1),
`durable_files` (8), `migration` (2), `projection_backlog` (3),
`queue_admission_shutdown` (1), `queue_pause` (1), `queue_shutdown` (2),
`settings` (6), `subsession_legacy` (1), and `tools_effects` (6).
Both shutdown cases cover the active turn and queued follow-ups across restart.
The full source check retained the 499-test/393-unmarked ratchet, had 1,798
modules in 49 domains, and reduced existing Agent function-length baselines;
no source or prompt budget increased.

The release suite covers WM-01 creation/integrity/scope/DAG rejection;
WM-08 publication retry and restart recovery; WM-09 join, sparse rewiring,
tombstones and completion immutability; the creation subset of WM-14; WM-15
exact review, stale results, null research and recursive coverage; initial
WM-19/20/22 routing, prompt budgets, normal effects, one-write bootstrap,
canonical nested delegation and lower-tier refusal; and Core WM-13 below.
It also proves external queue producers wake a settled Core dispatcher.

## Owner-scale measurements

The release fixture retains 100,000 Tasks across Plans and a selected
10,000-Task/30,000-edge Plan, 10,000 Spec nodes to depth eight with 50,000
criteria, over 600 chats/300,000 events, 2,440 transcripts (about 1.5 GB total,
290,000 lines in the largest), and 353,100,000 bytes of current metrics records.
Its App DB is 1,777,082,368 bytes; BTCC is 7,628,382,208 bytes. Thirty-two
durable active assignments and eight simultaneous Worker Summary readers add
metadata contention. They are stub fixture assignments, not eight live models.

The 19-test release run measured the following. All timing gates were enforced,
with count/order/revision/content assertions; these are local WSL numbers, not
fixed batch-CI or owner-machine measurements.

| Path | p50 | p95 / total | Gate |
|---|---:|---:|---:|
| Summary, 50 cards | 5.245 ms | 8.706 ms | warm 100 ms |
| Summary, first cold request | — | 14.760 ms | cold 250 ms |
| Eight concurrent Worker Summary readers | 23.071 ms | 34.275 ms | 100 ms |
| Graph, warm pages | 22.711 ms | 24.038 ms | warm 150 ms |
| Graph, first page | — | 25.219 ms | cold 300 ms |
| Complete 10k/30k graph, including client union assertions | — | 523.643 ms | 2 s |
| Exact Spec and ancestor chain (eight nodes), five criteria each | 1.568 ms | 6.223 ms | 150 ms |
| Bounded metadata edits | 0.998 ms | 1.267 ms | 100 ms |
| Actual affected-region DAG add/remove | 16.695 ms | 18.919 ms | 200 ms |
| Graph warm pages after 1,000 edits | 19.350 ms | 20.584 ms | 150 ms |

Every Summary page (200) and Graph page (20) remains retrievable with exact
10,000-node/30,000-edge unions, criterion bindings and deterministic order.
The test rejects stale cursors, checks graph revision 1,001 after the edits, and
compares the complete current Summary/receipts across restart. No reduced
response, stale cached state or sampled graph substitutes for those assertions.

Initial 10k-Task graph publication/activation took 414.081 ms, including actual
Ledger publication; whole-process setup `write_chars` was 148,357,077 and kernel
`write_bytes` 73,297,920, with 7,485 retained Ledger bytes. The small Tier 1
brief bundle took 23.073 ms with 545,478 `write_chars` and 696,320 `write_bytes`.
These setup costs are reported rather than hidden as model overhead; they are
not charged to the separate bounded-metadata-operation write budget.

For 1,000 varied inputs of at most 4 KiB (step/reorder and real DAG mutations),
whole-process writes including post-work drain/checkpoint were 77,387,402 bytes:
77,387 bytes/operation, below 128 KiB/op and 128 MiB/1,000. Incremental peak RSS
was 819,200 bytes, below 32 MiB. CPU was 1,970 ms and peak RSS 166,412,288 bytes
during the mutation loop. There were 6,000 Work-model lane operations and
29,700 actual BTCC SQL statements; process read characters were 9,799,428,
disk reads 8,192 bytes and kernel writes 76,967,936 bytes. SQL counts are actual
executions, not manually assigned labels.

In three settled 60-second windows, Work-model storage operations remained
five, all BTCC SQL/queue scan counters stayed unchanged, and SQLite/WAL/Ledger
lengths and modification times stayed unchanged: zero Work-model writes,
zero graph/queue polling queries, and no empty durable events. Whole-process
reads were 98,620 / 54,831 / 54,831 bytes; RSS was 86,687,744 bytes in each
window. Existing PERF-IDLE gates remain below 1 MB read/minute and 100 MB RSS.
Process write characters (885 / 653 / 661) were network responses/keepalive,
not managed database/file writes. Physical device SSD writes are unavailable;
the report distinguishes conservative process/checkpoint accounting from
kernel disk accounting and does not invent a hardware measurement.

After explicitly syncing all retained fixture files, the final two WM-13 cases
passed in 342.46 s with every gate enabled. On the primary fixture, Summary
p50/p95 was 5.278/17.007 ms (cold 8.750 ms); eight concurrent reads were
22.532/34.033 ms; graph pages were 22.245/23.191 ms (cold 24.234 ms), and the
complete graph took 513.577 ms. Exact Spec reads were 1.510/2.374 ms;
metadata edits 1.036/1.390 ms; DAG edits 17.131/20.249 ms. Published-Spec
activation after mutations/idle was 2.671/22.433 ms; the separate equivalent
owner-scale activation case was 2.359/11.384 ms. Each activation sample checks
all six cards, three Works/Spec refs, nine edges, bindings and identical retry.

Final mutation writes were 77,359,538 bytes (77,359/op), incremental peak RSS
655,360 bytes, CPU 2,060 ms and peak RSS 175,026,176 bytes. Lane operations/SQL
statements remained 6,000/29,700. Process reads were 9,758,468 characters and
4,096 disk bytes; kernel writes were 76,865,536 bytes. Idle reads were
98,620/54,831/54,831 bytes and RSS 93,462,528/93,462,528/93,470,720 bytes;
all three windows again had zero managed writes/polling/empty events.
App/BTCC sizes were 1,777,082,368/7,628,308,480 bytes. Initial graph publication
and activation took 491.455 ms, with 148,868,612 process write characters and
73,211,904 kernel write bytes. The earlier latency failures and unproven cause
remain disclosed below; these local passes do not replace fixed-runner CI.

## Prompt and model overhead

Actual Tier 0 provider requests used one normal model call. Their corresponding
static system/tool baseline was 50,471 bytes / 32 schemas / 10,238 estimated
tokens; Core was 44,253 / 27 / 9,288. Tier 0 contains no Spec context.
The existing role/phase fixture separately bounds Butler, Steward and Worker,
legacy and phase-enabled, direct/read-only/execution surfaces against each
corresponding baseline; nested delegation schemas require the explicit grant
and bootstrap phase.

Tier 1 made one bootstrap structured write in the existing two-request tool
loop, with no classifier/approval round. Static bytes/schemas/tokens were
44,253 / 27 / 9,288; complete dynamic input estimates were 267 and 697 tokens.
Nested Tier 2 rounds had static maxima of 44,253 bytes / 27 schemas / 9,288
tokens and minima of 32,229 / 23 / 6,678. Complete dynamic inputs ranged from
269 to 4,060 tokens; responsible bodies, inherited constraints and criterion
references remain present. Token estimates use `cl100k_base`, not provider
billing claims.

## Reproduced failures and corrections

The first seeded fixture had an extra SQL parenthesis; correcting the fixture
made it execute. An early release resource run then reproduced 22.9–24.8 MB/min
idle reads despite zero Core SQL. Narrow syscall observation traced repeated
transcript reads caused by the projection watcher treating its own read-access
notification as a change. Core now filters those notifications; the final
enforced resource run and existing append/backlog regressions pass. No timeout,
read budget, response content or idle gate was weakened.

A new recursive-coverage E2E reproduced premature parent completion after only
the parent's direct review passed. Coverage now requires mapped child groups
and separate unplanned parent integration criteria; the E2E passes. Static
role/phase fixtures exposed nested Worker schemas outside bootstrap; gating
them to the applicable phase fixed that mismatch. Additive durable enum values
were included in the existing format-pin fixture. Clippy's helper-loop warning
was fixed with iteration and an exact count assertion.

An intermediate regression command incorrectly selected the release binary for
four existing debug-only filesystem fault tests. Those tests expect injection
compiled under `debug_assertions` and failed in that profile. The final full
regression run uses the debug binary and all eight durability cases pass.
These were implementation/fixture/profile corrections, not flaky-test retries;
no tests were skipped, ignored or relaxed, and no main-only failure was shown.
The additional activation sampler initially used an obsolete `s:` prefix on
the newly returned gateway session ID and received `session_not_found` before
activation. Its input now uses the returned ID exactly, like `settings` E2Es.
The CLI sampler initially counted a catalog file as a Ledger project; it now
selects the managed project namespace explicitly and asserts exactly one root.

Additional enforced runs observed activation p95 383.870 ms against 100 ms and
Spec-read p95 762.133 ms against 150 ms. The isolated activation case measured
p95 23.723 ms on the same complete scale fixture. Host I/O/memory pressure was
observable, but a causal attribution for the latency outliers was not proven.
Fixture Spec bodies, transcripts and metrics now explicitly sync file contents
and directory entries before measurement, rather than merely flushing userspace
buffers. Both activation checks remain enabled, including the check after
sustained mutations/idle; no timing bound, sample count or response assertion
was removed. These failures remain part of the evidence, not a claimed diagnosis
or a fixed-runner performance pass.

## Explicit limits and deviations

The phase 1 mutation wire carries one closed `command`, rather than the design
§4 general ordered `operations[]` cross-command/control batch. Initial
Spec/Plan/Work/Task/edge creation is still one atomic bundle and every command
has a durable receipt. The unified instruction/grant/control protocol is owned
by the later instructions/controls rows; the core transport does not claim that
batch contract. See `btcc/work/managed/contracts.rs:186` and the capability
description in `host/guided/work_model.rs:106`.

In-use split/replacement/escalation/add/edit, pause/stop/resume, Task-bound queue
and Steer ingress, migration, UI/tree-wide coverage browsing, and Spec-change
propagation are unavailable in this core slice. Lower-tier delegation stays
pending when it needs those operations; it does not silently create a child or
widen authority. Accordingly WM-21, control/queue safe-point latencies, coverage
page/propagation, migration throughput and UI/reconnect budgets are not claimed.
The next branch rows in `work-model-design.md:431` onward assign that work.

Fixed batch-CI, macOS/Windows, the supplied 2.6 GB snapshot and physical SSD
accounting were not available on this WSL host. The larger synthetic repository
fixture and real release measurements above supply local evidence; combined
platform/owner acceptance remains the acceptance row at
`work-model-design.md:436`. No PR was opened: the coordinator batches branches
and runs CI once under the task's delivery rules.
