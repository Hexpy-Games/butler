> Historical round 3 report from `eb50ecb1d`. Current implementation and
> measurements are in [CI speed round 4](CI-speed-4.md).

# Build and CI speed, round 3

`rust-quality.yml` owns one always-running `gate`. It selects Rust, Bun, site,
DS, and native packaging checks by paths. The gate rejects failures,
cancellations and unexpected skips. Docs outside site source select only the
gate; ordinary UI/site edits do not compile Rust; `.rs`-only edits do not run
Bun/site jobs. Existing native updater/package integration paths still select
native package smokes. PR concurrency uses the branch, with cancellation on a
new push. Merge groups also get the gate.

Each native platform builds the workspace once in the release profile, retaining
debug-test assertions and overflow checks. One nextest archive supplies workspace
tests, six measured E2E shards, installation tests and serial performance tests.
All scenarios link through `crates/butler-e2e/tests/e2e/main.rs`. MCP executables,
cassettes, data fixtures, resources and packaging scripts resolve through the
remapped checkout. Consumers install standalone nextest, without a compiler.

The release performance selection still includes every module containing a
wall-clock helper, all `perf_*` cases and the existing storage-resilience minimum
lock-hold assertion. PERF-IDLE runs its full libtest observation from the archive,
with the same behavior as its former cargo-test runner. No assertions, content,
ignored cases, deadlines, budgets or retries are weakened. The regular install
watchdog remains 360 seconds.

Linux uses mold. sccache keys include compiler inputs, target, features and flags;
rust-cache additionally keys workspace retention by source content, native mode,
platform, toolchain and lockfile. No source timestamps are forged. Static ORT
retains the existing recipe fingerprint and adoption digest checks, outside the
Cargo target. The main/macOS producer now populates that cache and its same-run
release payload serves Rust checks, standalone install and App package smokes.
Linux native packages and installer smokes likewise consume compatible same-run
payloads. Tagged release and standalone/manual callers retain their native builds.

Installation fixture pairs hash their immutable executable/resources once, then
produce two complete independently verified archives. The installer still hashes
each extracted version. No process-manager waits or stable-stop windows changed.
Install-only jobs avoid embedding downloads; only the Linux install job probes
the user manager. All checks use disposable HOME/BUTLER_DATA and remove them.

[Nextest archive/remapping behavior](https://nexte.st/docs/ci-features/archiving/)
is documented by nextest; all consumers use the same checked-out revision.

Windows workflow files, release jobs, Windows action and existing Windows job
blocks are unchanged. Branch protection must switch to `gate` only after the
coordinator merges the batched workflow change; it is not changed by this branch.

## Observed job wall times

Collected with `gh run list` and `gh run view --json jobs`; duration is
`completedAt - startedAt`, excluding runner queue time. Runs are observations,
not a controlled cold/warm benchmark. Empty-cache measurements are unavailable
where marked; a dependency-cache hit does not mean zero rebuilds. Older runs
before #441 are excluded from performance comparisons because they ran less
performance coverage.

Sources: [current main 36994244496](https://github.com/Hexpy-Games/butler/actions/runs/36994244496),
[PR Rust 36998968537](https://github.com/Hexpy-Games/butler/actions/runs/36998968537),
[native checks 36998968442](https://github.com/Hexpy-Games/butler/actions/runs/36998968442),
[install 36998968137](https://github.com/Hexpy-Games/butler/actions/runs/36998968137),
[App package 36998968102](https://github.com/Hexpy-Games/butler/actions/runs/36998968102).

| Existing job | Main / cold or partial (s) | PR / restored dependencies (s) | Cache qualification |
| --- | ---: | ---: | --- |
| Format/source | 69 | 71 | No controlled cache comparison |
| Linux x64 clippy | 391 | 174 | PR Cargo dependency cache hit |
| Linux workspace tests | 606 | 278 | PR Cargo dependency cache hit |
| Linux E2E archive build | 653 | 278 | PR Cargo dependency cache hit |
| Linux E2E ordinary 1/3 | 341 (failed) | 351 | Archive consumer; compiler warmth N/A |
| Linux E2E ordinary 2/3 | 274 | 387 | Archive consumer; compiler warmth N/A |
| Linux E2E ordinary 3/3 | 273 | 221 | Archive consumer; compiler warmth N/A |
| Linux install 1/2 | 222 | 255 | Archive consumer; compiler warmth N/A |
| Linux install 2/2 | 180 | 246 | Archive consumer; compiler warmth N/A |
| Linux release perf | 2057 | 2798 | Release compilation; exact cold/warm unavailable |
| Linux arm64 checks | 901 | N/A | No matching PR sample |
| macOS Rust checks | 2837 | 2190 (failed) | PR dependency cache hit; unrelated long-path failure |
| Standalone install Linux x64 | 530 | 447 | PR dependency cache hit |
| Standalone install Linux arm64 | 481 | 482 | PR dependency cache hit |
| Standalone install macOS | 2335 | 1909 | PR dependency cache hit |
| Installer script/npm lint | 14 | 11 | No Rust compilation |
| Manifest merge | 10 | 9 | No Rust compilation |
| macOS App package | N/A | 3901 (ORT miss) | Warm static-ORT sample unavailable |

The App-package ORT miss alone occupied about 16m45s; the entire PR job took
65m01s. Another package run, 36976745282, missed the same recipe key and took
63m25s. These PR-scoped misses are evidence for populating the compatible cache
on main and sharing one payload, not evidence of a warm static build.

For #380, the unchanged main-era macOS run already passed INS-02 in **185.417s**
and INS-08 in **166.124s**, below 360s. Historical #355 instead spent 150–160s on
the first fixture archive and exceeded the whole-test budget. Round 3 removes
one additional source digest pass per pair and retains both full archives.

## Estimates, not new CI measurements

The coordinator runs the batched CI once; this branch creates no PR or CI rerun.
New-platform/profile cache population is initially cold. Expected archive build
ranges: Linux x64 15–30m cold / 3–10m warm; macOS 35–60m cold including ORT /
8–20m warm. These are planning ranges derived from the observed release build
and native jobs, not measured speedups.

Consumers should take about 20–60s for workspace tests, 2–4m per ordinary shard,
2–5m for install selections, and 10–18m for the complete serial performance tier
(including the full five-minute owner-scale idle observation). Package/install
consumer estimates exclude producer wait: macOS App 3–8m, standalone install
2–4m, Linux packaging 3–8m. A fully warm Rust gate is estimated at 18–40m, with
macOS/performance the critical path. Queue contention and cache eviction remain
unmeasured. Replacing previously concurrent partial/debug builds reduces total
compiler work; these estimates do not promise every individual job gets faster.

Measured E2E duration inputs come from run 36998968537. Longest-first allocation
balances all six ordinary shards at approximately **519.6–522.1s aggregate test
time** before concurrency. Ignored/new tests remain in the inventory; unknown
new tests receive a conservative default weight. Job logs list nextest selections
before execution, and artifacts retain the compiled list and shard mapping.

## Local validation and remaining evidence

The native debug Agent build completed in **24m40s cold**, then **1.455s warm**
wall time on this local arm64 Mac. This is not a release CI measurement. The
complete executable was **533,156,304 bytes**. The remapped nextest archive
selected 37 existing stub scenarios: **36 passed, one failed**, in 394.236s.
INS-02 passed in **141.548s** and INS-08 in **123.620s**, with the unchanged 360s
watchdog and both full version archives. INS-14's existing non-Linux guard
returns immediately on this host; real systemd behavior awaits Linux CI.

PROC-01 failed with `Operation not permitted`. A separate isolated diagnostic
confirmed `/bin/ps` spawn is denied by this sandbox, while `proc_name` and
`proc_pidpath` succeed. Its archived-role restoration companion passed. Evidence
was added to [existing issue #425](https://github.com/Hexpy-Games/butler/issues/425#issuecomment-5952998612);
PROC-01 was not retried or weakened. An initial archive invocation omitted the
prebuilt-binary environment and attempted a native rebuild; it was interrupted,
then the invocation was corrected before the recorded validation above.

Compiled before/after E2E inventories are identical: **265 tests, 14 ignored**.
Actual nextest listings of the retained old binaries and new archive establish
identical ordinary/install unions and all **45** previous performance selections.
The complete local workspace list contains **767 tests across 21 binaries**.
Combining unchanged workspace binaries with the retained pre-consolidation E2E
binaries selects 748 runnable cases under the former workspace filter. The new
workspace consumer selects 501 runnable cases (502 listed, one ignored), with
E2Es supplied by their dedicated consumers. Their union preserves every old
selection plus the four separately enforced performance cases; no test is lost.
Performance modules overlap ordinary selections; the four dedicated `perf_*`
cases run in the serial performance job, including the full idle observation.

| Selection | Before runnable tests | After runnable tests |
| --- | ---: | ---: |
| Ordinary hash shards | 72 / 84 / 75 | 38 / 39 / 38 / 40 / 38 / 38 |
| Install hash shards | 6 / 10 | 16 |
| Performance, including separate idle | 45 | 45 |
| Workspace, previously including gated E2Es | 748 | 501 plus dedicated E2E consumers |
| Preserved ignored E2E scenarios | 14 | 14 |

Checks passed: `cargo fmt --all`; all-target `clippy -D warnings` for butler-e2e
and butler-source-check; the source-check command and its 16 existing tests;
actionlint (shellcheck/pyflakes integration disabled because the local shellcheck
binary cannot execute on this CPU); YAML parsing; gate selection/cancellation
checks (192 combinations); path-filter examples; Windows job/file preservation;
`git diff --check`; frozen Bun install; site check/build, DS leak and font checks.

Current main's Linux
[shutdown record-write failure #451](https://github.com/Hexpy-Games/butler/issues/451), the native long-path failure and local Bun
failures are existing evidence, not silently green results. Bun's 956 passes,
22 skips and three failures include the existing #452/#418 five-second timeouts;
those issues received this run's observations. No unchanged failed test was
retried. New CI wall times, release-profile budget results and package reuse
smokes await the coordinator's single batched CI run. Git refused worktree
`index.lock` and `FETCH_HEAD` writes with `Operation not permitted`; fetch without
writing FETCH_HEAD confirmed origin/main still at `53fa0a3130da5e4181d9ed163ab2bbe874fc7ce3`.
The implementation is uncommitted and cannot be pushed from this environment.
