# Rust PR gate

Platform, Linux package, and full install PR checks run after the gate, with
their existing path filters and test selections. They also run after a failed
gate, so failures do not suppress coverage. Their callers use `!cancelled()`
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

Six hash partitions cover the non-install scenarios. INS-02 and INS-14 have
one dedicated job each, and a third install job covers every other `ins_`
scenario. The selections are disjoint and exhaustive. Each run uses zero
retries and at most eight test threads. PERF-01 reserves those slots while
sampling its existing owner-scale latency budget. Only INS-14 probes systemd; install
jobs do not restore the embedding model because they never use it. INS-14
requires the Linux runner's user manager and uses its config directory with
a temporary HOME. It retains both 12-second stable-stop observations.

Linux setup uses mold. The archive job strips debug information and executable
symbols after building, without changing assertions or test selection. Compiler
profiles stay unchanged to reuse existing dependency caches. The build and
Clippy jobs use Cargo's `-j 8` option rather than changing dependency-cache
environment inputs. Workspace libraries are cached as well. Each tracked Rust
workspace file is hashed in full: only matching contents reuse a cached source
timestamp, and changed contents receive a fresh timestamp even when backdated.
The source job proves both artifact reuse and rebuilding changed contents with
an actual Cargo fixture, including saving/restoring its executable and
dependency records. Non-library targets discarded by rust-cache are kept in
a separate cache directory, so unchanged integration binaries also stay fresh. The new cache can seed itself from existing dependency
caches and only saves after successful builds.
The agent qualification build script reads Git with optional locks disabled,
so checking a watched index cannot refresh it and trigger a second agent link.
Post-build stripping preserves dependency cache fingerprints; the job restores the former workspace Tests
cache rather than the smaller E2E cache. The gate reads the existing sccache
compiler cache; only rust-cache writes dependency archives. Per-crate sccache
uploads exhausted the cache API write quota and prevented the bulk cache save
during the cold round-2 measurement. The nextest archive is already
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
