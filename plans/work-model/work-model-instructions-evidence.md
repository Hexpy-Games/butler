# Work-model instruction implementation evidence

Phase 2 of the `codex/work-model-instructions` row in
[the binding design](work-model-design.md#9-implementation-branches-and-acceptance),
built on `origin/codex/work-model-core` at
`27460728434e08109eb9cd439447f29dc6a6c665`.
This is an evidence report, not a second implementation checklist.
Validation ran on Linux x86_64 WSL, 2026-10-03, with stub/replay providers,
fresh temporary HOME/BUTLER_DATA inside TMPDIR, Cargo `-j8`, four functional
E2E threads and one resource-test thread. No live model or owner store was used.

## Delivered behavior

Opt-in Core messages, initial assignments, legacy parent control ingress and
nested parent instructions use one durable envelope: stable request ID,
runtime-authenticated sender, immutable Queue/Steer mode, text/opaque attachment
references, ordered typed operations, reason, graph/control revisions and parent
relation epoch. The follow-up setting is snapshotted at admission; explicit mode
wins. Identical duplicates return the canonical receipt; changed payloads reject.
Disabled Core retains the existing queue and subsession behavior.

Queue captures the current canonical Task/attempt and survives Turn completion,
blocking and restart. Tier 0 captures the current answer Turn, without creating
managed rows. Tier 1 drafts reuse the existing brief, Work and Spec binding;
A→X and the draft ID survive until explicit binding resolution or question
cancellation. Unknown criteria or growth requiring later escalation leaves a
truthful needs-input draft and prevents the next Task claim. No placeholder
stop Task or extra approval round is created. Child results remain runtime
result delivery, allowing the parent to receive evidence before Task review.

Steer drains at resume, before provider requests, before every tool dispatch,
after tool results, and before wait/final/completion. Provider responses selected
under stale control epochs cannot dispatch tools or finalize. The final/wait
seal and subsequent arrival wake are durable, rather than relying on the next
unrelated message. Serial Core tool dispatch retains valid provider tool/result
pairing. A separate indexed Steer dispatch lane and eligible-before-limit inbox
selection prevent held Queue instructions from starving control.

`work_read`, `work_apply` and `session_control` expose narrow grouped surfaces.
Ordered edits apply atomically with strict revision checks and immutable completed
Tasks. Parent scope is the current direct relation at every depth; typed controls
include add/edit/remove/reorder/dependencies/block. Owner edits supersede pending
parent edits on overlapping targets with source receipts; disjoint edits remain
visible. Parent transfer changes authority and pending result routes atomically,
rejects stale epochs and retains canonical Tasks, evidence and explicit holds.

Instruction admission, delivery, application and rejection have durable receipts.
Graph mutation, operation audit, instruction acknowledgment and outbox share one
transaction. Append-only operation links retain every ordered operation ID.
Receipt reads hydrate the complete history; outbox events carry explicitly named
operation-ID additions plus the current count/status/result. Operation events
also carry their instruction acknowledgment, avoiding a second audit and event
for the same mutation. Recovery does not reapply committed tools or graph edits.

## Acceptance evidence

All new coverage is in the public-path `butler-e2e` work-model suite. Existing
format/surface fixtures were updated without adding non-E2E tests or raising
prompt, test-count, timing, response or resource budgets.

| Acceptance | Observed assertions |
|---|---|
| WM-02 | Queue during A creates stable X with A→X; A receives no mid-Task injection; completion releases X in the same Turn before B; resolve/start exactly once; A and the single brief remain unchanged. |
| WM-03 | Steer reorders B/C while A runs, with matching list/DAG/revisions; stale B start is fenced. Ordered edit + invalid start rolls back. Typed idle block adds no model request. |
| WM-05 | Queue and Steer reach child, worker and nested worker; current-relation add/edit/remove/reorder/dependency edits succeed; sibling/out-of-scope mutations reject. |
| WM-06 | Instructions during a held provider response and at the exact last final/wait boundary are applied or durably pending; stale final and filesystem effects are fenced. |
| WM-07 | Same/different-payload duplicate IDs, owner/parent overlapping and disjoint edits, competing parent authority, transfer and stale relation epochs retain deterministic receipts and state. |
| WM-10 | Crash after durable injection redelivers the instruction; active Turn plus all three queued follow-ups recover into distinct Turns. Explicit retry preserves original text. Mutation/completion faults retain graph, receipt, outbox and persisted tool result without a second operation. |
| WM-18 | Queue stays Queue across Steer; a 60-message Task-held queue cannot hide Steer; all 62 receipts and 60 drafts remain available. Questions cancel drafts without execution; unavailable escalation remains pending and blocks a new claim. |
| Boundary WM-19/20/22 | Tier 0 has zero managed rows; Tier 1 has one brief and one bootstrap write; nested delegation retains the canonical Plan/Task and delivers parent results before review. All role/phase static surfaces remain below their corresponding legacy budgets. |

The mutation-before-receipt crash window is eliminated by the shared SQLite
transaction. Fault tests crash after that transaction/tool-result persistence
and verify exact replay, instead of manufacturing a non-atomic acknowledgment
window. Restart uses the existing explicit-resume policy; no automatic effect
retry was introduced.

## Checks and tests

Commands below ran through `crates/butler-e2e/scripts/isolated-run.sh`.
E2Es used `BUTLER_E2E_TIER=stub`, the explicit built agent binary, and temporary
Bun 1.3.11. Resource checks additionally used `BUTLER_E2E_PERF=1` and the release
agent, with the debug harness retaining fault injection for functional tests.

| Check | Result |
|---|---|
| Debug work-model functional suite, `cargo test -p butler-e2e --test work_model -- --skip wm_13 --test-threads=4` | 33 passed, zero failed/ignored; final 46.72 s. Only the two separately enforced release resource cases are selected out. |
| Release owner-scale cases, `cargo test -p butler-e2e --test work_model wm_13 -- --test-threads=1 --nocapture`, PERF=1 | 2 passed, zero failed/ignored; 339.08 s; every resource/timing gate enforced. |
| Existing regressions, targets below | 53 distinct tests passed across 17 targets; one unchanged pre-existing automation CLI ignore. |
| Final receipt/event-change rerun: projection_backlog, queue_admission_shutdown, queue_pause, queue_shutdown, settings, subsession_legacy | 14 passed, zero failed/ignored; projection target 80.98 s. |
| Rust library suites, Agent/Gateway/Runtime/Turn, four threads | 266 passed (39/45/72/110), zero failed/ignored, including the Gateway child-process format pins. |
| `cargo fmt --all` | Passed. |
| `cargo clippy -p butler-turn -p butler-runtime -p butler-gateway -p butler-agent -p butler-e2e --all-targets -- -D warnings` | Passed; final 21.51 s. |
| `cargo run -p butler-source-check -- .` | Passed: zero function/platform/test/architecture/model/E2E violations; 1,816 modules, 49 domains. |
| Bun 1.3.11 `install --frozen-lockfile --ignore-scripts`; `bun run check` | Both passed; 1,605 packages, install 32.81 s. No TS/UI changes. |

Existing targets and passing counts: cli_surface (1), durable_configuration (1),
durable_files (8), migration (2), projection_backlog (3),
queue_admission_shutdown (1), queue_pause (1), queue_shutdown (2), recovery (7),
settings (6), subsession_legacy (1), tools_effects (6), turn (6), turn_faults (1),
ask_user (3), automation (2), session_branches (2). Ask-user's settled 60-second
window recorded zero App/BTCC commits with the complete pending question.
No existing test was newly ignored, retried, skipped or loosened to pass.
The source checker retains 499 non-E2E tests / 393 unmarked. Existing function
baselines only decreased: Agent dispatch 261→223, execute 141→139, Gateway queue
update 214→207. No new test-count or function-length exception was blessed.

## Performance corrections and scope

A diagnostic debug resource run exceeded the 100 MB idle RSS gate (165.58 MB).
The pristine phase-1 Core debug binary also exceeded it (176.30 MB); phase 1
records resource validation with a release binary. Resource validation here
therefore uses that same release profile, without changing the gate.

The first release run reproduced 208,780,064 whole-process write characters per
1,000 operations, exceeding 128 KiB/op. It rewrote each instruction's cumulative
operation-ID array into audit, outbox and App projection. Append-only indexed
links reduced this to 144,524,416, still above the gate. The remaining path wrote
a second instruction audit/event for every already-audited operation. The final
implementation shares the operation's audit/outbox transaction and event with
its receipt acknowledgment. Complete receipt reads still include all 1,001
ordered IDs, and every request/result remains durably audited. Both failed runs
remain disclosed; no budget, sample count, response field or item was removed.

Actual Tier 0 requests preserve one model call and zero managed entities. The
corresponding legacy static baseline is 50,471 bytes / 32 schemas / 10,238 token
estimate; Core uses 46,339 / 27 / 9,756. The existing all-role/all-phase fixture
also passes its unchanged bounds. Tier 1 retains one bootstrap write in the
normal two-request tool loop; an instrumented functional run measured 34.221 ms
and 504,113 process write characters / 643,072 kernel write bytes for bootstrap.
These setup writes are separate from bounded mutation accounting. Token
estimates are fixture estimates, not provider billing measurements.

## Final owner-scale measurements

The release fixture retains 100,000 Tasks across Plans, a selected
10,000-Task/30,000-edge Plan, 10,000 Spec nodes to depth eight with 50,000
criteria, 600+ chats/300,000 events, 2,440 transcripts (about 1.5 GB total,
290,000 lines in the largest), 353.1 MB of metrics, 32 active assignments and
eight concurrent Summary readers. App/BTCC sizes were
1,777,479,680 / 7,629,578,240 bytes. Fixtures explicitly sync retained files.

| Path | p50 | p95 / complete total | Unchanged gate |
|---|---:|---:|---:|
| Summary warm, complete 50-card page | 5.309 ms | 11.098 ms | 100 ms |
| First cold Summary | — | 7.877 ms | 250 ms |
| Eight concurrent Worker Summary reads | 23.874 ms | 35.296 ms | 100 ms |
| Graph warm pages | 22.592 ms | 23.691 ms | 150 ms |
| First cold Graph page | — | 23.181 ms | 300 ms |
| Entire 10k-Task/30k-edge graph, including client union assertions | — | 520.373 ms | 2 s |
| Exact Spec plus eight-node ancestor chain | 1.559 ms | 2.507 ms | 150 ms |
| Bounded metadata mutation | 1.088 ms | 1.523 ms | 100 ms |
| Actual affected-region DAG mutation | 17.057 ms | 20.045 ms | 200 ms |
| Typed instruction admission plus application, 32 edits | 1.658 ms | 2.491 ms | 100 ms warm |
| First typed instruction | — | 2.225 ms | 250 ms cold |

All timed paths assert full counts, order, current graph/Task revisions, latest
description and unchanged Spec bindings. All 200 Summary pages and 20 Graph
pages remain available. After 1,000 operations plus 32 typed instruction edits,
the complete graph is revision 1,033. The original receipt returns every
operation ID in order (`scale-create`, `mutation-0` through `mutation-999`);
all 33 instruction receipts are applied and compare exactly across restart.
Typed control adds zero provider requests and identical retries return exactly
the same receipts.

For 1,000 varied inputs ≤4 KiB, whole-process writes including drain/checkpoint
were 124,099,750 bytes: 124,099/op, below 128 KiB/op and 128 MiB/1,000.
Incremental peak RSS was 622,592 bytes, below 32 MiB. CPU was 2,390 ms, peak
RSS 174,948,352 bytes, Work-model storage-lane operations 7,999 and actual BTCC
SQL statements 42,599. Process reads were 14,575,436 characters / zero disk
read bytes; kernel write bytes were 123,514,880. These are process/kernel
measurements, not physical SSD counters. Initial publication/activation wrote
151,956,005 process characters / 77,209,600 kernel bytes with 7,485 retained
Ledger bytes; setup costs are reported separately from the mutation budget.

All three settled 60-second windows retained seven storage operations with
unchanged BTCC SQL/queue-scan counters and unchanged database/WAL/Ledger file
lengths and modification times: zero managed writes, zero idle graph/queue
polling and zero empty durable events. Whole-process reads were
113,215 / 54,831 / 54,831 bytes, below 1 MB/minute; RSS was 97,329,152 bytes in
each window, below 100 MB. Process write characters were 1,245 / 653 / 661
(network responses/keepalive), with no managed file writes. Resource gates are
enforced, not informational.

Published-Spec activation after sustained mutations/idle measured p50/p95
4.068/19.589 ms, and the separate equivalent owner-scale case measured
2.133/9.212 ms, both below 100 ms. Every activation sample checks complete six
Tasks, three Works/Spec refs, nine edges, bindings and identical retry. Both
release resource cases passed in 339.08 s with every gate enabled.

## Explicit limits and deviations

Pause/stop/resume and owned-tool cancellation remain the next controls branch;
`btcc/work/managed/instructions.rs:215` returns
`work_model_controls_unavailable`. In-use split/replacement/upward escalation
remain the subsequent Spec/replan branch; unresolved draft bindings at
`btcc/storage/work_model/instructions/drafts.rs:93` retain
`in_use_spec_replan_unavailable`. These operations are reported as unavailable
rather than simulated through a Task or an approval request.

`crates/butler-e2e/tests/automation.rs:178` already ignores AUTO-01-CLI because
CLI and App automation stores differ. The two runnable automation tests passed;
this separate existing product gap was not repaired or newly ignored here.
Open-issue searches for AUTO-01-CLI and automation/CLI store were inspected;
no duplicate issue was filed.

Fixed batch CI, macOS/Windows, the supplied 2.6 GB snapshot and physical SSD
write counters were unavailable on this host. The release synthetic fixture
provides local owner-scale evidence; platform/replay expansion and combined
acceptance remain the coordinator's final acceptance branch at
`work-model-design.md:436`. No PR, tag or merge is part of this delivery.

