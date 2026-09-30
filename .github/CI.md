# Rust PR gate

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
Clippy jobs explicitly pin their toolchain for cache fingerprinting, and use
Cargo's `-j 8` option rather than changing dependency-cache environment inputs.
Post-build stripping preserves dependency cache fingerprints; the job restores the former workspace Tests
cache rather than the smaller E2E cache. The nextest archive is already
zstd-compressed. The separate real agent is gzip-compressed, and upload-artifact's additional compression is
turned off. macOS and Windows retain their linker settings and coverage in
`post-merge-ci.yml`; duplicate platform jobs were removed from Rust quality.

Install fixture output reports binary size, hash time, and total archive
construction time. INS-02 retains its complete install, update, rollback,
registration, uninstall, and stable-restart assertions. Fixture compression
and product installation still process every byte of the real binary.
See the round-2 PR for measurements; local build-host timings and GitHub
runner job timings should be compared separately.
