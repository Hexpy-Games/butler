# Rust PR gate

Platform, Linux package, and full install PR checks run after the gate, with
their existing path filters and test selections. They also run after a failed
gate, so failures do not suppress coverage. Their callers and platform jobs use `!cancelled()`
to let superseded PR runs stop: `always()` would keep their builds running and
block the next run behind workflow concurrency. Main/nightly/manual triggers keep
their existing schedule. This prevents non-gate builds from occupying runners
while gate shards wait.

Require the **PR gate** check from `rust-quality.yml` for branch protection
and the merge queue. The workflow runs on `pull_request` and `merge_group`.
The summary accepts skipped Rust jobs only when the path detector confirms
that every changed path is under `plans/`, a `docs/` directory, or ends in
`.md`. Scheduled and manual runs always execute the Rust checks.

Linux builds all workspace targets in one Cargo invocation, including the real
agent and test executables. Nextest then packages those binaries without
recompiling a second dependency feature graph. Archive consumers run the
standalone nextest executable and do not install a compiler toolchain. The
nextest archive contains unit/integration binaries and fixture executables.
The Tests job runs every binary except the `e2e` integration binary; E2E jobs
select that binary explicitly. Doctests remain in the build job.

MCP fixture paths use nextest's remapped runtime executable path, with the
ordinary Cargo compile-time path as the fallback.

The E2E suite links once through `crates/butler-e2e/tests/e2e/main.rs`. Each
former test file is a module. Scenario function names and ignored flags are
unchanged; qualified names now include the module, for example
`install_lifecycle::ins_02_install_update_rollback_uninstall`. The source-check
test-count ratchet excludes this package regardless of its test layout.

Six hash partitions cover the non-install stub scenarios. PERF-01 retains its dedicated performance job and p95 report added on main; the opt-in release PERF-IDLE scenario keeps its existing tier. INS-02 and INS-14 have
one dedicated job each, and a third install job covers every other `ins_`
scenario. The selections are disjoint and exhaustive. Each run uses zero
retries and at most eight test threads. PERF-01 reserves those slots while
sampling its existing owner-scale latency budget. Full idle-calendar and
memory observation windows run early in their shard, after PERF-01, so their
unchanged durations overlap shorter scenarios rather than extend the tail. Only INS-14 probes systemd; install
jobs do not restore the embedding model because they never use it. INS-14
requires the Linux runner's user manager and uses its config directory with
a temporary HOME. It retains both 12-second stable-stop observations.

Linux setup uses mold. The archive job strips debug information and executable
symbols after building, without changing assertions or test selection. The Linux archive build disables debug information for dev/test profiles;
optimizations, debug assertions, overflow checks and test selections stay
unchanged. Clippy and macOS/Windows keep their existing profiles. The archive
cache therefore needs one population run with the new compiler inputs. The build and
Clippy jobs use Cargo's `-j 8` option rather than changing dependency-cache
environment inputs. Workspace libraries are cached as well. Each tracked Rust
workspace file is hashed in full: only matching contents reuse a cached source
timestamp, and changed contents receive a fresh timestamp even when backdated.
The source job proves both artifact reuse and rebuilding changed contents with
an actual Cargo fixture, including saving/restoring its executable and
dependency records. Non-library targets discarded by rust-cache are kept in
a separate cache directory, so unchanged integration binaries also stay fresh. The new cache can seed itself from existing dependency
caches and only saves after successful builds. Non-gate PR jobs still restore
main caches, but do not save competing PR copies. Failed/cancelled jobs do not
save build caches, avoiding quota churn and prolonged cancellation cleanup.
Main/nightly cache writes remain enabled for successful jobs.
The agent qualification build script reads Git with optional locks disabled,
so checking a watched index cannot refresh it and trigger a second agent link.
Post-build stripping preserves dependency cache fingerprints; the job restores the former workspace Tests
cache rather than the smaller E2E cache. Linux uses the bulk Cargo cache without per-crate GitHub sccache calls. One
Clippy run made 704 Rust cache misses and zero Rust hits, then hit a service
rate limit while saving its bulk cache—even with per-crate writes disabled.
Removing those lookups avoids hundreds of unproductive cache requests. Non-gate
PR jobs restore caches without saving competing copies; failed/cancelled jobs
do not save build caches. The nextest archive is already
zstd-compressed. The separate real agent is gzip-compressed, and upload-artifact's additional compression is
turned off. macOS and Windows retain their linker settings and coverage in
`post-merge-ci.yml`; duplicate platform jobs were removed from Rust quality.

Install fixture output reports binary size, hash time, and total archive
construction time. INS-02 retains its complete install, update, rollback,
registration, uninstall, and stable-restart assertions. Fixture compression
and product installation still process every byte of the real binary.
See the round-2 PR for measurements; local build-host timings and GitHub
runner job timings should be compared separately.

## Cache population measurement

The new workspace cache must be populated once before it can reuse Butler's
libraries. [Run 36682415547](https://github.com/Hexpy-Games/butler/actions/runs/36682415547)
seeded its dependency cache, checked all 2,546 tracked workspace files, ran
every gated test, and saved workspace artifacts. Its gate took 6m26s from
event creation. A fully cold dependency run took 15m53s; both remain in the
round-2 PR's report alongside the final warm measurement.

| Job | #346 baseline | Workspace cache population |
| --- | ---: | ---: |
| Archive | 2m19s (E2E only) | 3m36s (whole workspace) |
| Unit/integration tests | 3m42s | 26s |
| Clippy | 3m00s | 3m13s |
| Slowest stub shard | 4m14s | 2m24s |
| Slowest install selection | 3m25s | 2m16s |
| Gate, including queue time | 6m38s | 6m26s |

Warm PR measurements must use a `pull_request` run: GitHub scopes its caches to
`refs/pull/<number>/merge`, and a `workflow_dispatch` on the source branch
cannot restore that PR's cache. Keep cold and warm results separate and include
runner queue/startup time in the gate critical path. The integration-output
cache proof also confirmed identical complete nextest inventories after
restoration (local binary discovery: 3.51s missing outputs, 0.46s restored).

After deferring non-gate PR builds,
[run 36691615695](https://github.com/Hexpy-Games/butler/actions/runs/36691615695)
started all nine E2E selections within five seconds of the archive finishing.
Its gate passed in 6m31s: the workspace caches had been evicted, so the build
restored only dependencies, verified 2,550 source files without a saved timestamp
snapshot, and repopulated its workspace cache. Runner ordering fixes queue
contention; it cannot promise a warm build after GitHub cache quota eviction.

The E2E harness waits for both authenticated HTTP health and lifecycle readiness
of the actual child PID within the original 90-second startup deadline.
[Issue #366](https://github.com/Hexpy-Games/butler/issues/366) was reproduced with
a healthy HTTP fixture held in the `starting` lifecycle state; the old harness
returned early. Its regression also rejects a different PID's ready record.
The startup-port CLI assertions remain unchanged.


The stability batch merged during round-2 work adds a dedicated PERF-01 job;
its filter now selects module-qualified `::perf_` names from the single E2E
binary, and **PR gate** includes its result and unchanged 150 ms p95 limit.
PERF-IDLE keeps its existing opt-in release tier. Nextest inventory validation
covers 219 scenarios: 19 ignored live and 200 non-ignored selections. Six stub
partitions contain 27/34/24/27/34/36 scenarios, the install selections contain
1/1/14, and the performance job contains 2 (including opt-in PERF-IDLE).
Selections are disjoint and exhaustive; workspace archive tests run separately.

Cache transfer success and retention must be verified before calling a run
warm. In [run 36705834173](https://github.com/Hexpy-Games/butler/actions/runs/36705834173),
Clippy saved its 562 MB cache, but the archive save was rate-limited. That
Clippy entry was evicted before the next run. Removing this workflow's per-crate
cache calls reduced its requests but did not resolve shared cache pressure.
[Run 36707877010](https://github.com/Hexpy-Games/butler/actions/runs/36707877010)
then built the whole workspace cold in an 8m45s job (7m44s Cargo build), and
saved both workspace caches: 1,327,147,736 archive bytes and 562,193,734 Clippy
bytes. Cold compilation still exceeds the five-minute target. The PR report
keeps cold, warm, failed and queued measurements separate.

The shutdown MCP scenario added on main also resolves its fixture through
nextest's runtime path. Its archive relocation check passed with the original
build-host fixture executable removed; shutdown/reap deadlines remain intact.
The unchanged Q-02 failure in the preceding CI run is tracked in
[issue #374](https://github.com/Hexpy-Games/butler/issues/374). It did not reproduce
in the isolated local archive run; no cause or fix is claimed.


The control-request shutdown scenario measures an unchanged two-second budget;
like PERF-01, it reserves the runner's eight nextest execution slots while
sampling. Its deadline and assertions are unchanged. In
[issue #375](https://github.com/Hexpy-Games/butler/issues/375), CI recorded
2.146s with concurrent fixtures. The two-core local shard did not reproduce
that failure, so contention is not claimed as a demonstrated root cause.
The issue remains open; the scheduling change gives latency checks a consistent
measurement environment without skipping any scenarios.
