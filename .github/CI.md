# Rust PR gate

Require **PR gate** from `rust-quality.yml` for branch protection and the merge
queue. Both `pull_request` and `merge_group` run the gate. Its always-running
summary requires every gated job to succeed, unless path detection confirms
that all changes are under `plans/`, a `docs/` directory, or end in `.md`.
Scheduled and manual runs always execute Rust checks. See
[the round-2 PR](https://github.com/Hexpy-Games/butler/pull/355) for before/after
job timings, cache population measurements and the event-to-gate critical path.

## Build and test selections

Linux builds all workspace targets in one Cargo invocation, including the real
agent, unit/integration tests and fixture executables. Nextest packages these
outputs in one archive without recompiling another dependency feature graph.
Consumers use standalone nextest and do not install a compiler. The Tests job
runs every binary except `e2e`; doctests remain in the build job. MCP fixtures use
nextest's remapped runtime executable path, with the Cargo path as a fallback.

E2E links once through `crates/butler-e2e/tests/e2e/main.rs`. Former files become
modules, preserving leaf scenario names and ignored flags. Qualified names now
include the module, for example
`install_lifecycle::ins_02_install_update_rollback_uninstall`. Source-check's
non-E2E test-count ratchet excludes the package regardless of layout.

Six hash partitions cover non-install stub scenarios. INS-02 and INS-14 each
have a dedicated job; a third install job covers the other fourteen scenarios.
PERF-01 keeps main's dedicated performance job and p95 report; PERF-IDLE retains
its release opt-in tier. Actual nextest discovery proves the selections are
disjoint and exhaustive: stub counts 29/34/24/27/39/34, install counts 1/1/14,
and two performance selections. The inventory has 220 scenarios, including
15 existing ignored scenarios (ten live and five retired/opt-in scenarios) and the opt-in PERF-IDLE selection. Retries are zero;
E2E uses at most eight test threads.

Full startup-deadline and idle-memory/calendar observation windows run early
so their unchanged durations overlap shorter tests. PERF-01 and the strict
control-request shutdown test reserve eight slots while sampling their unchanged
budgets. In [#375](https://github.com/Hexpy-Games/butler/issues/375), CI's control
shutdown sample exceeded two seconds; a two-core local shard did not reproduce
it, so contention is not claimed as a demonstrated cause. The issue remains open.

Install jobs omit unused embedding assets. Only INS-14 probes systemd; it
requires the Linux runner's user manager and uses its config directory with
a temporary HOME. Both twelve-second stable-stop observations remain. Fixture
output reports complete binary size, hash time and archive construction time.
INS-02 retains install, update, rollback, registration, uninstall and stable
restart assertions. Real binary compression and installation still process
every byte. macOS INS-02/INS-08 timeouts at the unchanged six-minute limit are
tracked in [#380](https://github.com/Hexpy-Games/butler/issues/380); this Linux
host has not established their cause. Native linker/profile settings are unchanged.

## Linker, archive and caches

Linux uses mold. The archive dev/test profiles disable debug information while
retaining optimizations, debug assertions and overflow checks. Only executable
symbols/debug sections are stripped, preserving mtimes and library metadata.
Already-stripped ELF binaries are skipped after checking section metadata.
Nextest uses zstd; the real agent uses lossless gzip, and upload-artifact adds
no further compression. Clippy and native macOS/Windows retain their profiles.

Cargo uses `-j 8`. Linux uses the bulk Cargo cache without per-crate GitHub
sccache requests. Gate caches retain workspace libraries and a separate copy of
non-library outputs otherwise discarded by rust-cache. Their keys include a
Rust workspace source hash, excluding docs and target artifacts. On a miss,
read-only metadata selects the newest source snapshot visible to this PR ref
or main for the same OS/architecture; rust-cache still checks compiler,
environment and lockfile compatibility. Older caches seed the migration.

Every tracked workspace source is hashed in full. Only matching contents reuse
cached mtimes; changed or backdated inputs get fresh timestamps. An actual Cargo
fixture proves unchanged executable reuse, rebuilding changed contents to their
latest value, and failure after source deletion. Restored nextest inventories
are complete and identical. Git qualification reads use optional locks disabled
so reading the watched index cannot refresh it and cause another agent link.

Non-gate PR jobs restore main caches without saving competing PR copies. Gate,
main and nightly jobs save only after success; failed/cancelled builds do not
save. Cache quota eviction and shared service throttling can still cause cold
builds. Cold population exceeded five minutes and is reported separately from
warm measurements; no caches were deleted to manufacture a warm result.

## Runner ordering and harness readiness

Platform, Linux package and full install PR checks keep their existing path
filters and test steps but start after the gate, including after a failed gate.
Main/nightly/manual coverage retains its cadence. Callers and native jobs use
`!cancelled()` so superseded heads can stop; `always()` would prevent cancellation.
PR workflow concurrency is scoped to the head commit. Three small coordination
jobs acquire deferred caller groups immediately after path detection, cancelling
superseded native builds while the next archive builds. They run in runner.temp.
Other event types retain their prior branch-scoped concurrency.

The harness requires authenticated HTTP health and lifecycle readiness for the
current child PID within the original ninety-second deadline. A controlled
healthy-HTTP/instance-starting regression exposed premature readiness; the
regression also rejects readiness from a foreign PID (#366).

Main's #377 shutdown implementation stops App queue dispatch and completes any
in-flight admission before closing the native consumer. Interrupted work settles
with `turn_interrupted`; queued input resumes after restart. The earlier branch
Q-02 fix is superseded by main's implementation. Both main regression scenarios
are included in the single binary.

The in-flight admission fixture observes its committed claim through a separate
SQLite connection. Awaiting an HTTP terminal read can queue behind the deliberately
slow admission and miss the transaction under test (#381). The fixture keeps its
in-flight assertion and full post-restart turn/message/provider-call checks without
changing timeouts or budgets. Both shutdown queue regressions pass locally.
