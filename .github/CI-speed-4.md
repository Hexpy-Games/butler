# CI speed round 4

Measured on 2026-10-03 before changing the workflows. Round 3 (`eb50ecb1d`)
was merged into current main (`124e4dadf`), preserving newer E2Es and native
verification. No product implementation was changed.

Before the corrected measurement push, main advanced to `1bf694a91` (preview.8).
It was merged with all new E2Es, packaged UI/visual checks and their path
selectors preserved. The historical tables remain the observations collected
before this task; this newer input is identified separately in the run report.

## Method and baseline

The last five completed PR runs of each workflow were collected with
`gh run list --event pull_request`, followed by `gh run view --json jobs,...`.
For Butler Release, the last five completed tag-push runs were selected;
diagnostic dispatches were excluded. The Actions jobs API supplements the step
start/end timestamps absent from `gh run view`. The tables retain failures and
cancellations; medians of successful workflow wall times exclude both.
Queue time is job `started_at - created_at`; dependency waits are excluded from
queue time but included in workflow wall time. Workflow wall is final job
completion minus run creation. No controlled cache-cold versus cache-warm claim
is made. Composite actions expose one aggregate timestamp; their build/setup/
smoke work is explicitly labelled **Mixed**, rather than inventing substep times.
Windows post-release has only four historical runs. Legacy E2E PR runs precede
its migration into Rust quality; they are historical coverage, not a like-for-like
speed baseline. Windows installer/released-smoke dispatches are shown separately.

| Workflow | Last five completed run IDs (newest first) | Successful median wall (s) |
| --- | --- | ---: |
| bun-unit.yml | [37115518829](https://github.com/Hexpy-Games/butler/actions/runs/37115518829), [37114589478](https://github.com/Hexpy-Games/butler/actions/runs/37114589478), [37112203599](https://github.com/Hexpy-Games/butler/actions/runs/37112203599), [37109471917](https://github.com/Hexpy-Games/butler/actions/runs/37109471917), [37105562262](https://github.com/Hexpy-Games/butler/actions/runs/37105562262) | 95 |
| ds-site.yml | [37115518739](https://github.com/Hexpy-Games/butler/actions/runs/37115518739), [37114589528](https://github.com/Hexpy-Games/butler/actions/runs/37114589528), [37112203555](https://github.com/Hexpy-Games/butler/actions/runs/37112203555), [37109471982](https://github.com/Hexpy-Games/butler/actions/runs/37109471982), [37105562302](https://github.com/Hexpy-Games/butler/actions/runs/37105562302) | 91 |
| e2e.yml | [36600094240](https://github.com/Hexpy-Games/butler/actions/runs/36600094240), [36589231007](https://github.com/Hexpy-Games/butler/actions/runs/36589231007), [36584723474](https://github.com/Hexpy-Games/butler/actions/runs/36584723474), [36568074760](https://github.com/Hexpy-Games/butler/actions/runs/36568074760), [36564617900](https://github.com/Hexpy-Games/butler/actions/runs/36564617900) | 3261 |
| install-smoke.yml | [37114589636](https://github.com/Hexpy-Games/butler/actions/runs/37114589636), [37112203588](https://github.com/Hexpy-Games/butler/actions/runs/37112203588), [37109471920](https://github.com/Hexpy-Games/butler/actions/runs/37109471920), [37105562340](https://github.com/Hexpy-Games/butler/actions/runs/37105562340), [37094209197](https://github.com/Hexpy-Games/butler/actions/runs/37094209197) | 820 |
| licenses.yml | [37115518759](https://github.com/Hexpy-Games/butler/actions/runs/37115518759), [37114589512](https://github.com/Hexpy-Games/butler/actions/runs/37114589512), [37112203717](https://github.com/Hexpy-Games/butler/actions/runs/37112203717), [37109471991](https://github.com/Hexpy-Games/butler/actions/runs/37109471991), [37105562263](https://github.com/Hexpy-Games/butler/actions/runs/37105562263) | 14 |
| linux-packages.yml | [37114589544](https://github.com/Hexpy-Games/butler/actions/runs/37114589544), [37112203614](https://github.com/Hexpy-Games/butler/actions/runs/37112203614), [37109471960](https://github.com/Hexpy-Games/butler/actions/runs/37109471960), [37105562343](https://github.com/Hexpy-Games/butler/actions/runs/37105562343), [37094209167](https://github.com/Hexpy-Games/butler/actions/runs/37094209167) | 652 |
| macos-app-package.yml | [37114589514](https://github.com/Hexpy-Games/butler/actions/runs/37114589514), [37112203616](https://github.com/Hexpy-Games/butler/actions/runs/37112203616), [37109472014](https://github.com/Hexpy-Games/butler/actions/runs/37109472014), [37105562258](https://github.com/Hexpy-Games/butler/actions/runs/37105562258), [37094209205](https://github.com/Hexpy-Games/butler/actions/runs/37094209205) | 2388 |
| macos-signing.yml | [37115518750](https://github.com/Hexpy-Games/butler/actions/runs/37115518750), [37114589480](https://github.com/Hexpy-Games/butler/actions/runs/37114589480), [37112203646](https://github.com/Hexpy-Games/butler/actions/runs/37112203646), [37109471989](https://github.com/Hexpy-Games/butler/actions/runs/37109471989), [37105562292](https://github.com/Hexpy-Games/butler/actions/runs/37105562292) | 40 |
| post-merge-ci.yml | [37114589668](https://github.com/Hexpy-Games/butler/actions/runs/37114589668), [37112203909](https://github.com/Hexpy-Games/butler/actions/runs/37112203909), [37109472531](https://github.com/Hexpy-Games/butler/actions/runs/37109472531), [37105562581](https://github.com/Hexpy-Games/butler/actions/runs/37105562581), [37094209345](https://github.com/Hexpy-Games/butler/actions/runs/37094209345) | 2198 |
| release.yml | [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061), [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931), [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272), [36868276394](https://github.com/Hexpy-Games/butler/actions/runs/36868276394), [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | 3946 |
| rust-quality.yml | [37114589672](https://github.com/Hexpy-Games/butler/actions/runs/37114589672), [37112204069](https://github.com/Hexpy-Games/butler/actions/runs/37112204069), [37109472196](https://github.com/Hexpy-Games/butler/actions/runs/37109472196), [37105562550](https://github.com/Hexpy-Games/butler/actions/runs/37105562550), [37094209335](https://github.com/Hexpy-Games/butler/actions/runs/37094209335) | 1478 |
| site.yml | [37115518787](https://github.com/Hexpy-Games/butler/actions/runs/37115518787), [37114589479](https://github.com/Hexpy-Games/butler/actions/runs/37114589479), [37112203632](https://github.com/Hexpy-Games/butler/actions/runs/37112203632), [37109471973](https://github.com/Hexpy-Games/butler/actions/runs/37109471973), [37105562276](https://github.com/Hexpy-Games/butler/actions/runs/37105562276) | 32 |
| windows-installer.yml | [37117607706](https://github.com/Hexpy-Games/butler/actions/runs/37117607706), [37116604844](https://github.com/Hexpy-Games/butler/actions/runs/37116604844), [37115523360](https://github.com/Hexpy-Games/butler/actions/runs/37115523360), [37112224665](https://github.com/Hexpy-Games/butler/actions/runs/37112224665), [37094301811](https://github.com/Hexpy-Games/butler/actions/runs/37094301811) | 1902 |
| windows-preview-smoke.yml | [37114589482](https://github.com/Hexpy-Games/butler/actions/runs/37114589482), [37112203542](https://github.com/Hexpy-Games/butler/actions/runs/37112203542), [37109472026](https://github.com/Hexpy-Games/butler/actions/runs/37109472026), [37105562252](https://github.com/Hexpy-Games/butler/actions/runs/37105562252), [37094209183](https://github.com/Hexpy-Games/butler/actions/runs/37094209183) | 1411 |
| windows-released-smoke.yml | [37100987112](https://github.com/Hexpy-Games/butler/actions/runs/37100987112), [37076359725](https://github.com/Hexpy-Games/butler/actions/runs/37076359725), [37075129426](https://github.com/Hexpy-Games/butler/actions/runs/37075129426), [37074301433](https://github.com/Hexpy-Games/butler/actions/runs/37074301433) | 286 |

## Critical paths and changes

The latest successful tag run, **37097207061**, took **4052 s (67m32s)**.
macOS spent **3357 s (55m57s)** preparing the native Agent, with no Cargo cache,
then **335 s** packaging the App. Linux x64 App packaging spent **1064 s** in
native setup and **1618 s** rebuilding an Agent already built by its standalone
archive job. Windows Agent build took **1133 s** and Squirrel packaging **331 s**.
Release publication waited for macOS, then manifest/checksum publication.

PR **37112204069** spent **1484 s (24m44s)** in Linux perf: **408 s** building
its separate release Agent and **1038 s** in the performance step. The latter
includes another **457 s** compiling release E2Es (from the job log): about
**14m25s** of this perf job was compilation, before executing the checks. Native macOS
checks in **37112203909** took about 35 minutes (failed). The standalone macOS
install job rebuilt an Agent in parallel with Rust and App packaging. Windows
preview **37112203542** queued its native build for **1376 s (22m56s)** before
**372 s** of work, then spent **770 s** in disposable hosted verification.
Runner contention can dominate Windows even with warm compilation.

- One debug Rust build/archive per platform supplies workspace tests, six
  ordinary E2E shards and three install selections, preserving original debug
  hooks/assertions and avoiding optimization of every unit-test binary.
  One production Agent build supplies native package/install/perf consumers;
  a small optimized E2E-only archive supplies three serial perf shards.
  macOS also builds real .90/.91 update fixtures once and passes them through
  the existing smoke input, retaining embedded-version/signature/update proofs.
  PERF-IDLE has its own runner and retains the full five-minute observation.
  Test assertions, overflow checks, all budget helpers, existing ignored cases,
  watchdogs and zero retries are preserved. Producer-side invariants prove the
  compiled inventory is covered completely, with disjoint shard assignments.
- Agent-only artifacts avoid downloading/extracting an entire test archive in
  packaging jobs. Each PR install/package job waits only for its own platform.
  Tagged Linux App packaging also waits only for its own native Agent; the
  unchanged three x64 distribution smokes and ARM64 Ubuntu smoke still gate
  publication. Windows App packaging overlaps hosted Agent verification.
  Main's unconditional Rust selection and original UI/site/package selectors
  remain; the gate rejects failed, cancelled and unexpected skipped checks.
- macOS releases now restore fingerprinted static ORT and Cargo outputs and use
  sccache. Cargo cache keys distinguish architecture/native mode, toolchain,
  flags and lockfile. Cargo validates restored source fingerprints; the action
  ignores its additional `key` input when `shared-key` is set.
  Tracked `BUTLER_MEMORY_IMPLEMENTATION_COMMIT` changes rebuild the embedded
  revision when a commit changes, even if Rust files do not.
  Provenance also runs `--version` to reject a different embedded version.
- Release Linux App packages consume the standalone Agent's exact executable;
  they no longer rebuild it. Windows App packaging overlaps hosted Agent
  verification; publication still waits for verification. Existing Windows
  native jobs share a Cargo namespace, retaining profile/CRT/LTO fingerprints,
  existing persistent sccache/Bun caches and owner-registration sentinels.
- Windows hosted remote, recovery and data harnesses run on separate
  disposable runners. Installed release/UI/lifecycle/Task Scheduler checks
  and the command matrix keep their real install dependency. Completion artifacts prove all 12
  original hosted harnesses ran exactly once, and the gate rejects any failed,
  cancelled or skipped required producer/verification job.
- Release reuse verifies the actual checkout SHA, version, platform, static ORT,
  release profile, toolchain, assertions/overflow settings, flags and SHA256.
  Only completed successful same-repository CI runs qualify. Forks, failed
  runs, expired/incompatible artifacts and ordinary PR-head/merge-commit
  mismatches never qualify. Ordinary checks retain debug assertions/overflow
  checks; perf and release payloads retain original production settings. These
  configurations cannot share one executable without changing check semantics.
  Most tags will miss PR reuse because the SHA or embedded version differs;
  the normal cached native build remains the required fallback.
- Successful Cargo producers also preserve compatible complete target outputs
  as two-day artifacts, outside the shared 10 GB cache eviction pool. Restore
  requires compiler/native mode/flags/lockfile identity, checksum and a
  successful same-repository native producer, then Cargo validates sources.
- The static runtime has the same artifact fallback, keyed by the existing
  recipe fingerprint. It preserves the full SDK tree, including required
  relative links. The recipe still verifies every archive, library, protoc
  digest and build setting after restore; extraction rejects escaping paths.
- Bun package caches include OS, architecture, actual Bun version and lockfile,
  and live outside disposable HOME. `post-release-verify.yml` runs the existing
  published macOS and Windows install/update checks and both Linux native
  install/reinstall smokes concurrently. It only accepts existing public tags
  and neither builds release payloads nor publishes anything.

The completed cold experiment and per-job phases are recorded in
[CI-speed-4-runs.md](CI-speed-4-runs.md). It failed and is not a speedup claim.

## Estimates before the measurement PR

These are planning ranges, not measured speedups. A cold new release-profile
cache can make the first run slower; hosted queue and yw-pc contention remain.

| Workflow/check group | Observed successful median | Expected warm round 4 | After measurement |
| --- | ---: | ---: | --- |
| Linux Rust gate coverage | 24m38s | shared build 3–8m + longest consumer 5–8m | pending draft PR |
| Native macOS Rust + App/install coverage | separate 36m38s / 39m48s / 13m40s | shared build 8–18m + longest consumer 5–12m | pending draft PR |
| Windows preview | 23m31s; one run 42m03s including contention | existing contracts retained; cache/queue dependent | 21m10s, run 37124231972; other corrected checks pending |
| Butler Release | 65m46s; latest 67m32s | 20–35m with warm native caches; 35–65m cold | no tag authorized; not measured after |
| Published verification | separate platform dispatches | max(platform duration), rather than their sum | existing tags only; not dispatched by this task |

## Local validation

Rust 1.91 fmt, all-target `clippy -D warnings` on butler-e2e/source-check, source
rules and all **16 existing source-check tests** pass. The compiled consolidated
E2E inventory contains **306 tests, 14 existing ignored**. Ordinary shards contain
**47/48/49/47/48/47** listed cases, install selections **1/1/14**, and performance
**12/17/18 plus one complete idle observation**. Ordinary/performance overlap is
intentional and preserves the former ordinary and enforced-budget runs. The
union covers all **292 runnable E2Es**; every budget selection remains included.
Four CI invariant tests validate exact artifact identity/digest, reject failed/
foreign runs, reject failed/cancelled/skipped selected gate jobs, and prove
compiled coverage. Actionlint and frozen Bun install/full check pass with Bun
1.3.11. An initial shell used the host default Rust 1.98; its new Clippy lints
failed in unchanged code. Running the repo's pinned 1.91 corrected that toolchain
mismatch. Native execution, complete E2E results and new workflow durations will
be reported from the single draft PR; no unchanged failed CI run will be retried.

## Per-job timings

Queue = job started_at − created_at (excludes dependency wait).
Composite steps cannot be decomposed using job metadata; shown as mixed.
Cancelled/failed timings are not successful workflow speed measurements.

| Workflow / job | n (success/failure/cancelled) | Queue | Setup/cache | Build/package | Tests/checks | Upload/publish | Mixed | Other | Wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Bun unit tests / Fast Bun unit suite | 5 (5/0/0) | 8 | 24 | 0 | 41 | 0 | 0 | 6 | 81 |
| Butler Release / Attach Linux App packages to the draft release | 4 (4/0/0) | 2 | 12 | 0 | 0 | 10 | 0 | 3 | 25 |
| Butler Release / Build Linux Agent archive (linux-arm64) | 5 (5/0/0) | 15 | 3 | 0 | 0 | 4 | 2032 | 15 | 2055 |
| Butler Release / Build Linux Agent archive (linux-x64) | 5 (5/0/0) | 51 | 3 | 0 | 0 | 4 | 2779 | 18 | 2802 |
| Butler Release / Build and publish native macOS arm64 artifacts | 5 (4/1/0) | 409 | 26 | 3599 | 55 | 29 | 0 | 11 | 3725 |
| Butler Release / Build and smoke Linux App packages / Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | 4 (4/0/0) | 3 | 13 | 0 | 0 | 0 | 0 | 38 | 52 |
| Butler Release / Build and smoke Linux App packages / Install smoke (debian:trixie, linux-x64 deb) | 4 (4/0/0) | 4 | 13 | 0 | 0 | 0 | 0 | 38 | 54 |
| Butler Release / Build and smoke Linux App packages / Install smoke (ubuntu:24.04, linux-arm64 deb) | 4 (4/0/0) | 5 | 8 | 0 | 0 | 0 | 0 | 38 | 45 |
| Butler Release / Build and smoke Linux App packages / Install smoke (ubuntu:24.04, linux-x64 deb) | 4 (4/0/0) | 3 | 10 | 0 | 0 | 0 | 0 | 39 | 50 |
| Butler Release / Build and smoke Linux App packages / Package (linux-arm64) | 5 (5/0/0) | 107 | 789 | 1326 | 0 | 5 | 0 | 14 | 2135 |
| Butler Release / Build and smoke Linux App packages / Package (linux-x64) | 5 (4/1/0) | 78 | 1093 | 1790 | 0 | 13 | 0 | 21 | 2924 |
| Butler Release / Build unsigned Windows x64 Agent preview | 2 (2/0/0) | 3 | 32 | 0 | 2 | 15 | 1428 | 8 | 1485 |
| Butler Release / Package unsigned Windows Squirrel App | 2 (2/0/0) | 2 | 40 | 0 | 3 | 86 | 175 | 8 | 312 |
| Butler Release / Publish Linux Agent archives, merged manifests and the installer | 2 (2/0/0) | 4 | 10 | 0 | 0 | 6 | 0 | 2 | 19 |
| Butler Release / Publish consolidated release checksums | 2 (2/0/0) | 3 | 0 | 0 | 0 | 14 | 0 | 2 | 16 |
| Butler Release / Publish successful Agent archives, merged manifests and installers | 2 (2/0/0) | 4 | 8 | 0 | 0 | 6 | 0 | 2 | 16 |
| Butler Release / Publish successful Windows artifacts and merged App update manifest | 2 (2/0/0) | 2 | 30 | 0 | 0 | 32 | 0 | 12 | 74 |
| Butler Release / Publish the GitHub Release | 4 (4/0/0) | 2 | 0 | 0 | 0 | 1 | 0 | 3 | 4 |
| Butler Release / Publish the npm package | 2 (0/2/0) | 5 | 7 | 0 | 0 | 6 | 0 | 2 | 15 |
| Butler Release / Verify unsigned Windows x64 Agent preview | 2 (2/0/0) | 2 | 14 | 0 | 98 | 0 | 0 | 4 | 116 |
| Butler Release / release-checksums / Publish consolidated release checksums | 2 (2/0/0) | 2 | 0 | 0 | 0 | 22 | 0 | 2 | 25 |
| Butler Site / Check and build the site | 5 (5/0/0) | 3 | 10 | 8 | 9 | 0 | 0 | 4 | 28 |
| DS site / build | 5 (5/0/0) | 3 | 9 | 5 | 44 | 0 | 0 | 26 | 87 |
| E2E / E2E stub tier (Linux x64) | 5 (5/0/0) | 4 | 1067 | 385 | 895 | 0 | 0 | 30 | 2398 |
| E2E / E2E stub tier (macOS arm64) | 4 (4/0/0) | 249 | 38 | 566 | 974 | 0 | 0 | 1336 | 2929 |
| Install smoke / Install smoke (darwin-arm64) | 5 (4/0/1) | 9 | 7 | 0 | 68 | 1 | 743 | 8 | 824 |
| Install smoke / Install smoke (linux-arm64) | 5 (4/0/1) | 6 | 4 | 0 | 32 | 0 | 432 | 3 | 473 |
| Install smoke / Install smoke (linux-x64) | 5 (4/0/1) | 3 | 3 | 0 | 27 | 0 | 477 | 4 | 509 |
| Install smoke / Lint scripts and dry-run the npm package | 5 (5/0/0) | 3 | 5 | 0 | 1 | 2 | 0 | 3 | 11 |
| Install smoke / Merge per-platform manifests | 4 (4/0/0) | 4 | 5 | 0 | 0 | 0 | 0 | 2 | 7 |
| Linux packages / Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | 4 (4/0/0) | 3 | 10 | 0 | 0 | 0 | 0 | 32 | 42 |
| Linux packages / Install smoke (debian:trixie, linux-x64 deb) | 4 (4/0/0) | 3 | 22 | 0 | 0 | 0 | 0 | 34 | 56 |
| Linux packages / Install smoke (ubuntu:24.04, linux-arm64 deb) | 4 (4/0/0) | 20 | 8 | 0 | 0 | 0 | 0 | 34 | 42 |
| Linux packages / Install smoke (ubuntu:24.04, linux-x64 deb) | 4 (4/0/0) | 4 | 16 | 0 | 0 | 0 | 0 | 42 | 60 |
| Linux packages / Package (linux-arm64) | 5 (4/0/1) | 5 | 46 | 463 | 0 | 4 | 0 | 6 | 529 |
| Linux packages / Package (linux-x64) | 5 (4/0/1) | 3 | 45 | 514 | 0 | 13 | 0 | 8 | 584 |
| Open source notices / licenses | 5 (5/0/0) | 3 | 5 | 0 | 0 | 0 | 0 | 5 | 9 |
| Post-merge CI / Rust checks (macOS arm64) | 5 (3/1/1) | 8 | 48 | 128 | 1898 | 0 | 0 | 9 | 2084 |
| Post-merge CI / Windows compile check (x86_64-pc-windows-msvc) | 4 (4/0/0) | 3 | 40 | 0 | 170 | 0 | 0 | 16 | 234 |
| Post-merge CI / platform-paths | 5 (5/0/0) | 4 | 4 | 0 | 1 | 0 | 0 | 3 | 7 |
| Rust quality / Build E2E archive (Linux x64) | 5 (5/0/0) | 3 | 28 | 198 | 1 | 46 | 0 | 6 | 281 |
| Rust quality / Clippy (Linux x64) | 5 (5/0/0) | 3 | 22 | 0 | 146 | 0 | 0 | 4 | 170 |
| Rust quality / E2E install (Linux x64 1/2) | 5 (5/0/0) | 3 | 35 | 0 | 175 | 0 | 0 | 4 | 207 |
| Rust quality / E2E install (Linux x64 2/2) | 5 (5/0/0) | 3 | 34 | 0 | 133 | 0 | 0 | 3 | 169 |
| Rust quality / E2E perf (Linux x64) | 5 (4/0/1) | 3 | 30 | 408 | 1016 | 0 | 0 | 8 | 1462 |
| Rust quality / E2E stub (Linux x64 1/3) | 5 (5/0/0) | 3 | 32 | 0 | 426 | 0 | 0 | 4 | 468 |
| Rust quality / E2E stub (Linux x64 2/3) | 5 (5/0/0) | 3 | 29 | 0 | 291 | 0 | 0 | 3 | 321 |
| Rust quality / E2E stub (Linux x64 3/3) | 5 (5/0/0) | 3 | 49 | 0 | 203 | 0 | 0 | 6 | 257 |
| Rust quality / Format and source rules | 5 (5/0/0) | 4 | 12 | 0 | 56 | 0 | 0 | 4 | 71 |
| Rust quality / Tests (Linux x64) | 5 (5/0/0) | 4 | 26 | 0 | 256 | 0 | 0 | 7 | 297 |
| Unsigned Windows preview smoke / Build unsigned Windows preview | 5 (5/0/0) | 4 | 20 | 0 | 1 | 16 | 261 | 8 | 298 |
| Unsigned Windows preview smoke / Installed unsigned Windows preview | 5 (4/0/1) | 2 | 246 | 0 | 366 | 1 | 0 | 157 | 770 |
| Unsigned Windows preview smoke / Platform contracts and debug stub chat | 5 (5/0/0) | 185 | 20 | 57 | 200 | 22 | 0 | 7 | 325 |
| Verify published Windows preview / Install and use the released Windows asset | 4 (2/2/0) | 2 | 147 | 0 | 0 | 0 | 0 | 4 | 172 |
| Windows Squirrel install and update / Build Windows Squirrel artifacts | 2 (2/0/0) | 294 | 14 | 36 | 0 | 222 | 702 | 11 | 984 |
| Windows Squirrel install and update / Verify Windows install update uninstall | 4 (2/2/0) | 3 | 67 | 0 | 280 | 92 | 0 | 5 | 440 |
| macOS App package / Package and smoke unsigned darwin-arm64 App | 5 (1/3/1) | 8 | 98 | 840 | 82 | 0 | 0 | 13 | 1914 |
| macOS signing / no-identity and ad-hoc self-test | 5 (5/0/0) | 9 | 8 | 0 | 0 | 0 | 0 | 16 | 26 |
| macOS signing / shellcheck | 5 (5/0/0) | 3 | 4 | 0 | 0 | 0 | 0 | 3 | 6 |

Individual observations (all seconds):

| Run | Job | Result | Queue | Setup | Build | Test | Upload | Mixed | Other | Wall |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [36564617900](https://github.com/Hexpy-Games/butler/actions/runs/36564617900) | E2E stub tier (macOS arm64) | success | 899 | 45 | 593 | 973 | 0 | 0 | 1219 | 2830 |
| [36564617900](https://github.com/Hexpy-Games/butler/actions/runs/36564617900) | E2E stub tier (Linux x64) | success | 125 | 39 | 95 | 842 | 0 | 0 | 21 | 997 |
| [36568074760](https://github.com/Hexpy-Games/butler/actions/runs/36568074760) | E2E stub tier (Linux x64) | success | 3 | 1067 | 379 | 951 | 0 | 0 | 30 | 2427 |
| [36584723474](https://github.com/Hexpy-Games/butler/actions/runs/36584723474) | E2E stub tier (macOS arm64) | success | 136 | 40 | 574 | 974 | 0 | 0 | 1489 | 3077 |
| [36584723474](https://github.com/Hexpy-Games/butler/actions/runs/36584723474) | E2E stub tier (Linux x64) | success | 25 | 1039 | 408 | 895 | 0 | 0 | 56 | 2398 |
| [36589231007](https://github.com/Hexpy-Games/butler/actions/runs/36589231007) | E2E stub tier (Linux x64) | success | 4 | 1266 | 481 | 905 | 0 | 0 | 29 | 2681 |
| [36589231007](https://github.com/Hexpy-Games/butler/actions/runs/36589231007) | E2E stub tier (macOS arm64) | success | 8 | 36 | 547 | 958 | 0 | 0 | 1372 | 2913 |
| [36600094240](https://github.com/Hexpy-Games/butler/actions/runs/36600094240) | E2E stub tier (macOS arm64) | success | 362 | 37 | 559 | 1048 | 0 | 0 | 1301 | 2945 |
| [36600094240](https://github.com/Hexpy-Games/butler/actions/runs/36600094240) | E2E stub tier (Linux x64) | success | 3 | 1094 | 385 | 871 | 0 | 0 | 31 | 2381 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Build and publish native macOS arm64 artifacts | success | 409 | 24 | 4489 | 49 | 24 | 0 | 14 | 4600 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Build Linux Agent archive (linux-x64) | success | 51 | 3 | 0 | 0 | 3 | 1703 | 16 | 1725 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Build Linux Agent archive (linux-arm64) | success | 15 | 3 | 0 | 0 | 4 | 2034 | 14 | 2055 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Build and smoke Linux App packages / Package (linux-x64) | success | 78 | 1093 | 1742 | 0 | 13 | 0 | 21 | 2869 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Build and smoke Linux App packages / Package (linux-arm64) | success | 107 | 811 | 1363 | 0 | 4 | 0 | 13 | 2191 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Build and smoke Linux App packages / Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 33 | 27 | 0 | 0 | 0 | 0 | 39 | 66 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Build and smoke Linux App packages / Install smoke (ubuntu:24.04, linux-x64 deb) | success | 162 | 9 | 0 | 0 | 0 | 0 | 38 | 47 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Build and smoke Linux App packages / Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 93 | 13 | 0 | 0 | 0 | 0 | 42 | 55 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Build and smoke Linux App packages / Install smoke (debian:trixie, linux-x64 deb) | success | 180 | 15 | 0 | 0 | 0 | 0 | 39 | 54 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Publish Linux Agent archives, merged manifests and the installer | success | 5 | 13 | 0 | 0 | 9 | 0 | 2 | 24 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Attach Linux App packages to the draft release | success | 2 | 7 | 0 | 0 | 7 | 0 | 3 | 17 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Publish consolidated release checksums | success | 3 | 0 | 0 | 0 | 9 | 0 | 3 | 12 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Publish the GitHub Release | success | 3 | 0 | 0 | 0 | 2 | 0 | 2 | 4 |
| [36831736764](https://github.com/Hexpy-Games/butler/actions/runs/36831736764) | Publish the npm package | failure | 5 | 9 | 0 | 0 | 7 | 0 | 2 | 18 |
| [36868276394](https://github.com/Hexpy-Games/butler/actions/runs/36868276394) | Build and publish native macOS arm64 artifacts | failure | 7540 | 26 | 2645 | 27 | 8 | 0 | 9 | 2715 |
| [36868276394](https://github.com/Hexpy-Games/butler/actions/runs/36868276394) | Build Linux Agent archive (linux-x64) | success | 56 | 81 | 0 | 0 | 4 | 2789 | 25 | 2899 |
| [36868276394](https://github.com/Hexpy-Games/butler/actions/runs/36868276394) | Build Linux Agent archive (linux-arm64) | success | 51 | 90 | 0 | 0 | 4 | 1974 | 15 | 2083 |
| [36868276394](https://github.com/Hexpy-Games/butler/actions/runs/36868276394) | Build and smoke Linux App packages / Package (linux-arm64) | success | 294 | 785 | 1369 | 0 | 5 | 0 | 14 | 2173 |
| [36868276394](https://github.com/Hexpy-Games/butler/actions/runs/36868276394) | Build and smoke Linux App packages / Package (linux-x64) | failure | 547 | 1089 | 1896 | 0 | 0 | 0 | 15 | 3000 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Build Linux Agent archive (linux-arm64) | success | 450 | 3 | 0 | 0 | 4 | 2003 | 17 | 2027 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Build Linux Agent archive (linux-x64) | success | 1003 | 3 | 0 | 0 | 4 | 2779 | 16 | 2802 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Build and smoke Linux App packages / Package (linux-arm64) | success | 602 | 762 | 1261 | 0 | 5 | 0 | 13 | 2041 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Build and smoke Linux App packages / Package (linux-x64) | success | 88 | 1141 | 1844 | 0 | 12 | 0 | 25 | 3022 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Build and publish native macOS arm64 artifacts | success | 785 | 26 | 3599 | 60 | 29 | 0 | 11 | 3725 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Build and smoke Linux App packages / Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 3 | 12 | 0 | 0 | 0 | 0 | 37 | 49 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Build and smoke Linux App packages / Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 5 | 6 | 0 | 0 | 0 | 0 | 38 | 44 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Build and smoke Linux App packages / Install smoke (debian:trixie, linux-x64 deb) | success | 2 | 8 | 0 | 0 | 0 | 0 | 46 | 54 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Build and smoke Linux App packages / Install smoke (ubuntu:24.04, linux-x64 deb) | success | 3 | 12 | 0 | 0 | 0 | 0 | 40 | 52 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Attach Linux App packages to the draft release | success | 2 | 10 | 0 | 0 | 10 | 0 | 2 | 22 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Publish Linux Agent archives, merged manifests and the installer | success | 2 | 7 | 0 | 0 | 4 | 0 | 3 | 14 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Publish consolidated release checksums | success | 3 | 0 | 0 | 0 | 18 | 0 | 2 | 20 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Publish the GitHub Release | success | 2 | 0 | 0 | 0 | 1 | 0 | 3 | 4 |
| [36964994272](https://github.com/Hexpy-Games/butler/actions/runs/36964994272) | Publish the npm package | failure | 5 | 5 | 0 | 0 | 4 | 0 | 3 | 12 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Build Linux Agent archive (linux-arm64) | success | 4 | 2 | 0 | 0 | 4 | 2052 | 15 | 2073 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Build and publish native macOS arm64 artifacts | success | 92 | 31 | 3415 | 56 | 53 | 0 | 13 | 3568 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Build Linux Agent archive (linux-x64) | success | 3 | 4 | 0 | 0 | 5 | 2819 | 21 | 2849 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Build unsigned Windows x64 Agent preview | success | 3 | 14 | 0 | 2 | 17 | 1794 | 10 | 1837 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Build and smoke Linux App packages / Package (linux-x64) | success | 3 | 1099 | 1790 | 0 | 14 | 0 | 21 | 2924 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Build and smoke Linux App packages / Package (linux-arm64) | success | 79 | 793 | 1314 | 0 | 4 | 0 | 19 | 2130 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Verify unsigned Windows x64 Agent preview | success | 2 | 14 | 0 | 113 | 0 | 0 | 4 | 131 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Package unsigned Windows Squirrel App | success | 3 | 37 | 0 | 3 | 64 | 181 | 7 | 292 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Build and smoke Linux App packages / Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 5 | 6 | 0 | 0 | 0 | 0 | 33 | 39 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Build and smoke Linux App packages / Install smoke (ubuntu:24.04, linux-x64 deb) | success | 3 | 12 | 0 | 0 | 0 | 0 | 58 | 70 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Build and smoke Linux App packages / Install smoke (debian:trixie, linux-x64 deb) | success | 3 | 11 | 0 | 0 | 0 | 0 | 36 | 47 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Build and smoke Linux App packages / Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 3 | 8 | 0 | 0 | 0 | 0 | 32 | 40 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Publish successful Agent archives, merged manifests and installers | success | 4 | 8 | 0 | 0 | 6 | 0 | 3 | 17 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Attach Linux App packages to the draft release | success | 3 | 20 | 0 | 0 | 11 | 0 | 3 | 34 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Publish successful Windows artifacts and merged App update manifest | success | 3 | 39 | 0 | 0 | 38 | 0 | 2 | 79 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | release-checksums / Publish consolidated release checksums | success | 3 | 0 | 0 | 0 | 24 | 0 | 3 | 27 |
| [37068347931](https://github.com/Hexpy-Games/butler/actions/runs/37068347931) | Publish the GitHub Release | success | 3 | 0 | 0 | 0 | 1 | 0 | 3 | 4 |
| [37074301433](https://github.com/Hexpy-Games/butler/actions/runs/37074301433) | Install and use the released Windows asset | failure | 2 | 131 | 0 | 0 | 0 | 0 | 4 | 135 |
| [37075129426](https://github.com/Hexpy-Games/butler/actions/runs/37075129426) | Install and use the released Windows asset | failure | 2 | 127 | 0 | 0 | 0 | 0 | 5 | 132 |
| [37076359725](https://github.com/Hexpy-Games/butler/actions/runs/37076359725) | Install and use the released Windows asset | success | 2 | 205 | 0 | 0 | 0 | 0 | 4 | 209 |
| [37094209167](https://github.com/Hexpy-Games/butler/actions/runs/37094209167) | Package (linux-arm64) | success | 5 | 53 | 489 | 0 | 5 | 0 | 6 | 553 |
| [37094209167](https://github.com/Hexpy-Games/butler/actions/runs/37094209167) | Package (linux-x64) | success | 2 | 41 | 509 | 0 | 13 | 0 | 8 | 571 |
| [37094209167](https://github.com/Hexpy-Games/butler/actions/runs/37094209167) | Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 3 | 12 | 0 | 0 | 0 | 0 | 33 | 45 |
| [37094209167](https://github.com/Hexpy-Games/butler/actions/runs/37094209167) | Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 5 | 7 | 0 | 0 | 0 | 0 | 34 | 41 |
| [37094209167](https://github.com/Hexpy-Games/butler/actions/runs/37094209167) | Install smoke (ubuntu:24.04, linux-x64 deb) | success | 3 | 20 | 0 | 0 | 0 | 0 | 42 | 62 |
| [37094209167](https://github.com/Hexpy-Games/butler/actions/runs/37094209167) | Install smoke (debian:trixie, linux-x64 deb) | success | 3 | 24 | 0 | 0 | 0 | 0 | 36 | 60 |
| [37094209183](https://github.com/Hexpy-Games/butler/actions/runs/37094209183) | Build unsigned Windows preview | success | 4 | 20 | 0 | 0 | 11 | 140 | 7 | 178 |
| [37094209183](https://github.com/Hexpy-Games/butler/actions/runs/37094209183) | Platform contracts and debug stub chat | success | 185 | 20 | 41 | 166 | 23 | 0 | 7 | 257 |
| [37094209183](https://github.com/Hexpy-Games/butler/actions/runs/37094209183) | Installed unsigned Windows preview | success | 2 | 316 | 0 | 414 | 1 | 0 | 125 | 856 |
| [37094209197](https://github.com/Hexpy-Games/butler/actions/runs/37094209197) | Lint scripts and dry-run the npm package | success | 3 | 4 | 0 | 1 | 2 | 0 | 3 | 10 |
| [37094209197](https://github.com/Hexpy-Games/butler/actions/runs/37094209197) | Install smoke (linux-x64) | success | 3 | 3 | 0 | 30 | 0 | 472 | 3 | 508 |
| [37094209197](https://github.com/Hexpy-Games/butler/actions/runs/37094209197) | Install smoke (darwin-arm64) | success | 9 | 7 | 0 | 68 | 1 | 743 | 5 | 824 |
| [37094209197](https://github.com/Hexpy-Games/butler/actions/runs/37094209197) | Install smoke (linux-arm64) | success | 6 | 5 | 0 | 33 | 0 | 444 | 3 | 485 |
| [37094209197](https://github.com/Hexpy-Games/butler/actions/runs/37094209197) | Merge per-platform manifests | success | 2 | 3 | 0 | 0 | 0 | 0 | 3 | 6 |
| [37094209205](https://github.com/Hexpy-Games/butler/actions/runs/37094209205) | Package and smoke unsigned darwin-arm64 App | success | 7 | 1081 | 637 | 652 | 0 | 0 | 10 | 2380 |
| [37094209335](https://github.com/Hexpy-Games/butler/actions/runs/37094209335) | Format and source rules | success | 3 | 12 | 0 | 57 | 0 | 0 | 2 | 71 |
| [37094209335](https://github.com/Hexpy-Games/butler/actions/runs/37094209335) | Tests (Linux x64) | success | 4 | 23 | 0 | 248 | 0 | 0 | 4 | 275 |
| [37094209335](https://github.com/Hexpy-Games/butler/actions/runs/37094209335) | Clippy (Linux x64) | success | 3 | 24 | 0 | 123 | 0 | 0 | 5 | 152 |
| [37094209335](https://github.com/Hexpy-Games/butler/actions/runs/37094209335) | E2E perf (Linux x64) | success | 3 | 14 | 1652 | 1112 | 0 | 0 | 18 | 2796 |
| [37094209335](https://github.com/Hexpy-Games/butler/actions/runs/37094209335) | Build E2E archive (Linux x64) | success | 3 | 28 | 195 | 1 | 48 | 0 | 6 | 278 |
| [37094209335](https://github.com/Hexpy-Games/butler/actions/runs/37094209335) | E2E stub (Linux x64 3/3) | success | 4 | 48 | 0 | 200 | 0 | 0 | 6 | 254 |
| [37094209335](https://github.com/Hexpy-Games/butler/actions/runs/37094209335) | E2E stub (Linux x64 2/3) | success | 3 | 28 | 0 | 291 | 0 | 0 | 2 | 321 |
| [37094209335](https://github.com/Hexpy-Games/butler/actions/runs/37094209335) | E2E stub (Linux x64 1/3) | success | 3 | 30 | 0 | 423 | 0 | 0 | 3 | 456 |
| [37094209335](https://github.com/Hexpy-Games/butler/actions/runs/37094209335) | E2E install (Linux x64 1/2) | success | 3 | 45 | 0 | 183 | 0 | 0 | 6 | 234 |
| [37094209335](https://github.com/Hexpy-Games/butler/actions/runs/37094209335) | E2E install (Linux x64 2/2) | success | 3 | 50 | 0 | 146 | 0 | 0 | 5 | 201 |
| [37094209345](https://github.com/Hexpy-Games/butler/actions/runs/37094209345) | platform-paths | success | 3 | 3 | 0 | 1 | 0 | 0 | 3 | 7 |
| [37094209345](https://github.com/Hexpy-Games/butler/actions/runs/37094209345) | Rust checks (macOS arm64) | success | 9 | 24 | 402 | 2623 | 0 | 0 | 56 | 3105 |
| [37094209345](https://github.com/Hexpy-Games/butler/actions/runs/37094209345) | Windows compile check (x86_64-pc-windows-msvc) | success | 4 | 69 | 0 | 101 | 0 | 0 | 6 | 176 |
| [37094301811](https://github.com/Hexpy-Games/butler/actions/runs/37094301811) | Build Windows Squirrel artifacts | success | 343 | 15 | 6 | 1 | 191 | 639 | 12 | 864 |
| [37094301811](https://github.com/Hexpy-Games/butler/actions/runs/37094301811) | Verify Windows install update uninstall | success | 2 | 99 | 0 | 367 | 210 | 0 | 4 | 680 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Build and publish native macOS arm64 artifacts | success | 74 | 28 | 3697 | 55 | 32 | 0 | 11 | 3823 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Build Linux Agent archive (linux-x64) | success | 2 | 2 | 0 | 0 | 4 | 1932 | 18 | 1956 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Build Linux Agent archive (linux-arm64) | success | 5 | 2 | 0 | 0 | 3 | 2032 | 17 | 2054 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Build and smoke Linux App packages / Package (linux-x64) | success | 3 | 1086 | 1723 | 0 | 14 | 0 | 21 | 2844 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Build unsigned Windows x64 Agent preview | success | 3 | 50 | 0 | 1 | 13 | 1062 | 7 | 1133 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Build and smoke Linux App packages / Package (linux-arm64) | success | 7 | 789 | 1326 | 0 | 5 | 0 | 15 | 2135 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Verify unsigned Windows x64 Agent preview | success | 3 | 13 | 0 | 84 | 0 | 0 | 4 | 101 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Package unsigned Windows Squirrel App | success | 2 | 43 | 0 | 3 | 108 | 169 | 8 | 331 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Build and smoke Linux App packages / Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 5 | 9 | 0 | 0 | 0 | 0 | 37 | 46 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Build and smoke Linux App packages / Install smoke (debian:trixie, linux-x64 deb) | success | 4 | 19 | 0 | 0 | 0 | 0 | 37 | 56 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Build and smoke Linux App packages / Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 3 | 14 | 0 | 0 | 0 | 0 | 40 | 54 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Build and smoke Linux App packages / Install smoke (ubuntu:24.04, linux-x64 deb) | success | 3 | 9 | 0 | 0 | 0 | 0 | 38 | 47 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Publish successful Agent archives, merged manifests and installers | success | 3 | 8 | 0 | 0 | 7 | 0 | 1 | 16 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Attach Linux App packages to the draft release | success | 3 | 15 | 0 | 0 | 10 | 0 | 3 | 28 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Publish successful Windows artifacts and merged App update manifest | success | 2 | 21 | 0 | 0 | 26 | 0 | 21 | 68 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | release-checksums / Publish consolidated release checksums | success | 2 | 0 | 0 | 0 | 21 | 0 | 2 | 23 |
| [37097207061](https://github.com/Hexpy-Games/butler/actions/runs/37097207061) | Publish the GitHub Release | success | 2 | 0 | 0 | 0 | 1 | 0 | 3 | 4 |
| [37100987112](https://github.com/Hexpy-Games/butler/actions/runs/37100987112) | Install and use the released Windows asset | success | 3 | 163 | 0 | 0 | 187 | 0 | 5 | 355 |
| [37105562252](https://github.com/Hexpy-Games/butler/actions/runs/37105562252) | Platform contracts and debug stub chat | success | 3 | 24 | 76 | 204 | 24 | 0 | 8 | 336 |
| [37105562252](https://github.com/Hexpy-Games/butler/actions/runs/37105562252) | Build unsigned Windows preview | success | 341 | 12 | 0 | 0 | 16 | 261 | 9 | 298 |
| [37105562252](https://github.com/Hexpy-Games/butler/actions/runs/37105562252) | Installed unsigned Windows preview | success | 2 | 155 | 1 | 317 | 1 | 0 | 152 | 626 |
| [37105562258](https://github.com/Hexpy-Games/butler/actions/runs/37105562258) | Package and smoke unsigned darwin-arm64 App | failure | 10 | 1321 | 1990 | 82 | 0 | 0 | 43 | 3436 |
| [37105562262](https://github.com/Hexpy-Games/butler/actions/runs/37105562262) | Fast Bun unit suite | success | 9 | 24 | 0 | 42 | 0 | 0 | 54 | 120 |
| [37105562263](https://github.com/Hexpy-Games/butler/actions/runs/37105562263) | licenses | success | 3 | 4 | 0 | 0 | 0 | 0 | 5 | 9 |
| [37105562276](https://github.com/Hexpy-Games/butler/actions/runs/37105562276) | Check and build the site | success | 5 | 11 | 8 | 10 | 0 | 0 | 5 | 34 |
| [37105562292](https://github.com/Hexpy-Games/butler/actions/runs/37105562292) | shellcheck | success | 3 | 3 | 0 | 0 | 0 | 0 | 3 | 6 |
| [37105562292](https://github.com/Hexpy-Games/butler/actions/runs/37105562292) | no-identity and ad-hoc self-test | success | 7 | 6 | 0 | 0 | 0 | 0 | 10 | 16 |
| [37105562302](https://github.com/Hexpy-Games/butler/actions/runs/37105562302) | build | success | 5 | 9 | 6 | 44 | 0 | 0 | 26 | 85 |
| [37105562340](https://github.com/Hexpy-Games/butler/actions/runs/37105562340) | Lint scripts and dry-run the npm package | success | 4 | 7 | 0 | 1 | 3 | 0 | 1 | 12 |
| [37105562340](https://github.com/Hexpy-Games/butler/actions/runs/37105562340) | Install smoke (linux-x64) | success | 3 | 2 | 0 | 27 | 1 | 477 | 2 | 509 |
| [37105562340](https://github.com/Hexpy-Games/butler/actions/runs/37105562340) | Install smoke (darwin-arm64) | success | 11 | 7 | 0 | 84 | 1 | 641 | 8 | 741 |
| [37105562340](https://github.com/Hexpy-Games/butler/actions/runs/37105562340) | Install smoke (linux-arm64) | success | 6 | 3 | 0 | 32 | 0 | 420 | 2 | 457 |
| [37105562340](https://github.com/Hexpy-Games/butler/actions/runs/37105562340) | Merge per-platform manifests | success | 4 | 7 | 0 | 0 | 0 | 0 | 4 | 11 |
| [37105562343](https://github.com/Hexpy-Games/butler/actions/runs/37105562343) | Package (linux-arm64) | success | 5 | 46 | 447 | 0 | 4 | 0 | 7 | 504 |
| [37105562343](https://github.com/Hexpy-Games/butler/actions/runs/37105562343) | Package (linux-x64) | success | 2 | 62 | 451 | 0 | 11 | 0 | 8 | 532 |
| [37105562343](https://github.com/Hexpy-Games/butler/actions/runs/37105562343) | Install smoke (ubuntu:24.04, linux-x64 deb) | success | 3 | 18 | 0 | 0 | 0 | 0 | 44 | 62 |
| [37105562343](https://github.com/Hexpy-Games/butler/actions/runs/37105562343) | Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 2 | 9 | 0 | 0 | 0 | 0 | 32 | 41 |
| [37105562343](https://github.com/Hexpy-Games/butler/actions/runs/37105562343) | Install smoke (debian:trixie, linux-x64 deb) | success | 2 | 8 | 0 | 0 | 0 | 0 | 44 | 52 |
| [37105562343](https://github.com/Hexpy-Games/butler/actions/runs/37105562343) | Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 6 | 8 | 0 | 0 | 0 | 0 | 34 | 42 |
| [37105562550](https://github.com/Hexpy-Games/butler/actions/runs/37105562550) | Tests (Linux x64) | success | 3 | 20 | 0 | 574 | 0 | 0 | 22 | 616 |
| [37105562550](https://github.com/Hexpy-Games/butler/actions/runs/37105562550) | Format and source rules | success | 4 | 12 | 0 | 55 | 0 | 0 | 4 | 71 |
| [37105562550](https://github.com/Hexpy-Games/butler/actions/runs/37105562550) | Build E2E archive (Linux x64) | success | 2 | 16 | 509 | 0 | 44 | 0 | 18 | 587 |
| [37105562550](https://github.com/Hexpy-Games/butler/actions/runs/37105562550) | E2E perf (Linux x64) | success | 2 | 36 | 270 | 891 | 0 | 0 | 6 | 1203 |
| [37105562550](https://github.com/Hexpy-Games/butler/actions/runs/37105562550) | Clippy (Linux x64) | success | 3 | 22 | 0 | 466 | 0 | 0 | 16 | 504 |
| [37105562550](https://github.com/Hexpy-Games/butler/actions/runs/37105562550) | E2E install (Linux x64 1/2) | success | 2 | 35 | 0 | 156 | 0 | 0 | 4 | 195 |
| [37105562550](https://github.com/Hexpy-Games/butler/actions/runs/37105562550) | E2E stub (Linux x64 3/3) | success | 2 | 32 | 0 | 202 | 0 | 0 | 6 | 240 |
| [37105562550](https://github.com/Hexpy-Games/butler/actions/runs/37105562550) | E2E stub (Linux x64 2/3) | success | 3 | 103 | 0 | 296 | 0 | 0 | 11 | 410 |
| [37105562550](https://github.com/Hexpy-Games/butler/actions/runs/37105562550) | E2E install (Linux x64 2/2) | success | 2 | 30 | 0 | 133 | 0 | 0 | 3 | 166 |
| [37105562550](https://github.com/Hexpy-Games/butler/actions/runs/37105562550) | E2E stub (Linux x64 1/3) | success | 3 | 57 | 0 | 426 | 0 | 0 | 6 | 489 |
| [37105562581](https://github.com/Hexpy-Games/butler/actions/runs/37105562581) | platform-paths | success | 39 | 1 | 0 | 1 | 0 | 0 | 2 | 4 |
| [37105562581](https://github.com/Hexpy-Games/butler/actions/runs/37105562581) | Rust checks (macOS arm64) | success | 8 | 61 | 147 | 1930 | 0 | 0 | 8 | 2146 |
| [37109471917](https://github.com/Hexpy-Games/butler/actions/runs/37109471917) | Fast Bun unit suite | success | 8 | 24 | 0 | 31 | 0 | 0 | 5 | 60 |
| [37109471920](https://github.com/Hexpy-Games/butler/actions/runs/37109471920) | Lint scripts and dry-run the npm package | success | 4 | 4 | 0 | 2 | 2 | 0 | 4 | 12 |
| [37109471920](https://github.com/Hexpy-Games/butler/actions/runs/37109471920) | Install smoke (linux-x64) | success | 3 | 3 | 0 | 22 | 0 | 363 | 4 | 392 |
| [37109471920](https://github.com/Hexpy-Games/butler/actions/runs/37109471920) | Install smoke (linux-arm64) | success | 6 | 4 | 0 | 32 | 1 | 424 | 3 | 464 |
| [37109471920](https://github.com/Hexpy-Games/butler/actions/runs/37109471920) | Install smoke (darwin-arm64) | success | 8 | 10 | 0 | 70 | 1 | 1794 | 47 | 1922 |
| [37109471920](https://github.com/Hexpy-Games/butler/actions/runs/37109471920) | Merge per-platform manifests | success | 3 | 5 | 0 | 0 | 0 | 0 | 2 | 7 |
| [37109471960](https://github.com/Hexpy-Games/butler/actions/runs/37109471960) | Package (linux-x64) | success | 3 | 49 | 514 | 0 | 13 | 0 | 8 | 584 |
| [37109471960](https://github.com/Hexpy-Games/butler/actions/runs/37109471960) | Package (linux-arm64) | success | 6 | 45 | 445 | 0 | 4 | 0 | 6 | 500 |
| [37109471960](https://github.com/Hexpy-Games/butler/actions/runs/37109471960) | Install smoke (debian:trixie, linux-x64 deb) | success | 3 | 20 | 0 | 0 | 0 | 0 | 33 | 53 |
| [37109471960](https://github.com/Hexpy-Games/butler/actions/runs/37109471960) | Install smoke (ubuntu:24.04, linux-x64 deb) | success | 4 | 15 | 0 | 0 | 0 | 0 | 42 | 57 |
| [37109471960](https://github.com/Hexpy-Games/butler/actions/runs/37109471960) | Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 34 | 8 | 0 | 0 | 0 | 0 | 35 | 43 |
| [37109471960](https://github.com/Hexpy-Games/butler/actions/runs/37109471960) | Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 3 | 10 | 0 | 0 | 0 | 0 | 34 | 44 |
| [37109471973](https://github.com/Hexpy-Games/butler/actions/runs/37109471973) | Check and build the site | success | 3 | 10 | 5 | 6 | 0 | 0 | 3 | 24 |
| [37109471982](https://github.com/Hexpy-Games/butler/actions/runs/37109471982) | build | success | 3 | 10 | 5 | 43 | 0 | 0 | 29 | 87 |
| [37109471989](https://github.com/Hexpy-Games/butler/actions/runs/37109471989) | no-identity and ad-hoc self-test | success | 9 | 7 | 0 | 0 | 0 | 0 | 23 | 30 |
| [37109471989](https://github.com/Hexpy-Games/butler/actions/runs/37109471989) | shellcheck | success | 8 | 3 | 0 | 0 | 0 | 0 | 4 | 7 |
| [37109471991](https://github.com/Hexpy-Games/butler/actions/runs/37109471991) | licenses | success | 4 | 5 | 0 | 0 | 0 | 0 | 4 | 9 |
| [37109472014](https://github.com/Hexpy-Games/butler/actions/runs/37109472014) | Package and smoke unsigned darwin-arm64 App | failure | 10 | 98 | 559 | 55 | 0 | 0 | 11 | 723 |
| [37109472026](https://github.com/Hexpy-Games/butler/actions/runs/37109472026) | Build unsigned Windows preview | success | 3 | 13 | 0 | 1 | 20 | 280 | 9 | 323 |
| [37109472026](https://github.com/Hexpy-Games/butler/actions/runs/37109472026) | Platform contracts and debug stub chat | success | 330 | 20 | 103 | 231 | 21 | 0 | 7 | 382 |
| [37109472026](https://github.com/Hexpy-Games/butler/actions/runs/37109472026) | Installed unsigned Windows preview | success | 6 | 260 | 0 | 379 | 1 | 0 | 161 | 801 |
| [37109472196](https://github.com/Hexpy-Games/butler/actions/runs/37109472196) | Build E2E archive (Linux x64) | success | 3 | 27 | 194 | 1 | 46 | 0 | 4 | 272 |
| [37109472196](https://github.com/Hexpy-Games/butler/actions/runs/37109472196) | Tests (Linux x64) | success | 4 | 41 | 0 | 249 | 0 | 0 | 7 | 297 |
| [37109472196](https://github.com/Hexpy-Games/butler/actions/runs/37109472196) | Format and source rules | success | 4 | 9 | 0 | 30 | 0 | 0 | 4 | 43 |
| [37109472196](https://github.com/Hexpy-Games/butler/actions/runs/37109472196) | Clippy (Linux x64) | success | 3 | 24 | 0 | 150 | 0 | 0 | 3 | 177 |
| [37109472196](https://github.com/Hexpy-Games/butler/actions/runs/37109472196) | E2E perf (Linux x64) | success | 6 | 33 | 406 | 1016 | 0 | 0 | 7 | 1462 |
| [37109472196](https://github.com/Hexpy-Games/butler/actions/runs/37109472196) | E2E stub (Linux x64 2/3) | success | 3 | 34 | 0 | 282 | 0 | 0 | 3 | 319 |
| [37109472196](https://github.com/Hexpy-Games/butler/actions/runs/37109472196) | E2E install (Linux x64 1/2) | success | 3 | 29 | 0 | 175 | 0 | 0 | 3 | 207 |
| [37109472196](https://github.com/Hexpy-Games/butler/actions/runs/37109472196) | E2E install (Linux x64 2/2) | success | 3 | 34 | 0 | 132 | 0 | 0 | 3 | 169 |
| [37109472196](https://github.com/Hexpy-Games/butler/actions/runs/37109472196) | E2E stub (Linux x64 3/3) | success | 3 | 49 | 0 | 203 | 0 | 0 | 5 | 257 |
| [37109472196](https://github.com/Hexpy-Games/butler/actions/runs/37109472196) | E2E stub (Linux x64 1/3) | success | 3 | 32 | 0 | 424 | 0 | 0 | 4 | 460 |
| [37109472531](https://github.com/Hexpy-Games/butler/actions/runs/37109472531) | platform-paths | success | 4 | 4 | 0 | 1 | 0 | 0 | 3 | 8 |
| [37109472531](https://github.com/Hexpy-Games/butler/actions/runs/37109472531) | Windows compile check (x86_64-pc-windows-msvc) | success | 2 | 29 | 0 | 239 | 0 | 0 | 25 | 293 |
| [37109472531](https://github.com/Hexpy-Games/butler/actions/runs/37109472531) | Rust checks (macOS arm64) | success | 7 | 48 | 88 | 1766 | 0 | 0 | 7 | 1909 |
| [37112203542](https://github.com/Hexpy-Games/butler/actions/runs/37112203542) | Platform contracts and debug stub chat | success | 3 | 14 | 49 | 171 | 21 | 0 | 7 | 262 |
| [37112203542](https://github.com/Hexpy-Games/butler/actions/runs/37112203542) | Build unsigned Windows preview | success | 1376 | 20 | 0 | 1 | 20 | 324 | 7 | 372 |
| [37112203542](https://github.com/Hexpy-Games/butler/actions/runs/37112203542) | Installed unsigned Windows preview | success | 4 | 246 | 0 | 366 | 1 | 0 | 157 | 770 |
| [37112203555](https://github.com/Hexpy-Games/butler/actions/runs/37112203555) | build | success | 4 | 9 | 5 | 45 | 0 | 0 | 28 | 87 |
| [37112203588](https://github.com/Hexpy-Games/butler/actions/runs/37112203588) | Lint scripts and dry-run the npm package | success | 2 | 5 | 0 | 1 | 2 | 0 | 3 | 11 |
| [37112203588](https://github.com/Hexpy-Games/butler/actions/runs/37112203588) | Install smoke (darwin-arm64) | success | 7 | 8 | 0 | 68 | 2 | 584 | 5 | 667 |
| [37112203588](https://github.com/Hexpy-Games/butler/actions/runs/37112203588) | Install smoke (linux-x64) | success | 2 | 3 | 0 | 31 | 0 | 480 | 4 | 518 |
| [37112203588](https://github.com/Hexpy-Games/butler/actions/runs/37112203588) | Install smoke (linux-arm64) | success | 5 | 4 | 0 | 33 | 1 | 432 | 3 | 473 |
| [37112203588](https://github.com/Hexpy-Games/butler/actions/runs/37112203588) | Merge per-platform manifests | success | 31 | 5 | 0 | 0 | 0 | 0 | 2 | 7 |
| [37112203599](https://github.com/Hexpy-Games/butler/actions/runs/37112203599) | Fast Bun unit suite | success | 8 | 29 | 0 | 46 | 0 | 0 | 6 | 81 |
| [37112203614](https://github.com/Hexpy-Games/butler/actions/runs/37112203614) | Package (linux-arm64) | success | 4 | 56 | 463 | 0 | 4 | 0 | 6 | 529 |
| [37112203614](https://github.com/Hexpy-Games/butler/actions/runs/37112203614) | Package (linux-x64) | success | 3 | 45 | 518 | 0 | 13 | 0 | 9 | 585 |
| [37112203614](https://github.com/Hexpy-Games/butler/actions/runs/37112203614) | Install smoke (debian:trixie, linux-x64 deb) | success | 162 | 28 | 0 | 0 | 0 | 0 | 31 | 59 |
| [37112203614](https://github.com/Hexpy-Games/butler/actions/runs/37112203614) | Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 119 | 9 | 0 | 0 | 0 | 0 | 31 | 40 |
| [37112203614](https://github.com/Hexpy-Games/butler/actions/runs/37112203614) | Install smoke (ubuntu:24.04, linux-x64 deb) | success | 241 | 9 | 0 | 0 | 0 | 0 | 37 | 46 |
| [37112203614](https://github.com/Hexpy-Games/butler/actions/runs/37112203614) | Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 126 | 6 | 0 | 0 | 0 | 0 | 33 | 39 |
| [37112203616](https://github.com/Hexpy-Games/butler/actions/runs/37112203616) | Package and smoke unsigned darwin-arm64 App | failure | 8 | 95 | 840 | 966 | 0 | 0 | 13 | 1914 |
| [37112203632](https://github.com/Hexpy-Games/butler/actions/runs/37112203632) | Check and build the site | success | 4 | 12 | 8 | 10 | 0 | 0 | 5 | 35 |
| [37112203646](https://github.com/Hexpy-Games/butler/actions/runs/37112203646) | shellcheck | success | 4 | 4 | 0 | 0 | 0 | 0 | 2 | 6 |
| [37112203646](https://github.com/Hexpy-Games/butler/actions/runs/37112203646) | no-identity and ad-hoc self-test | success | 11 | 10 | 0 | 0 | 0 | 0 | 19 | 29 |
| [37112203717](https://github.com/Hexpy-Games/butler/actions/runs/37112203717) | licenses | success | 4 | 4 | 0 | 0 | 0 | 0 | 5 | 9 |
| [37112203909](https://github.com/Hexpy-Games/butler/actions/runs/37112203909) | platform-paths | success | 4 | 4 | 0 | 0 | 0 | 0 | 4 | 8 |
| [37112203909](https://github.com/Hexpy-Games/butler/actions/runs/37112203909) | Windows compile check (x86_64-pc-windows-msvc) | success | 4 | 50 | 0 | 80 | 0 | 0 | 4 | 134 |
| [37112203909](https://github.com/Hexpy-Games/butler/actions/runs/37112203909) | Rust checks (macOS arm64) | failure | 7 | 49 | 128 | 1898 | 0 | 0 | 9 | 2084 |
| [37112204069](https://github.com/Hexpy-Games/butler/actions/runs/37112204069) | E2E perf (Linux x64) | success | 4 | 30 | 408 | 1038 | 0 | 0 | 8 | 1484 |
| [37112204069](https://github.com/Hexpy-Games/butler/actions/runs/37112204069) | Format and source rules | success | 4 | 12 | 0 | 56 | 0 | 0 | 4 | 72 |
| [37112204069](https://github.com/Hexpy-Games/butler/actions/runs/37112204069) | Build E2E archive (Linux x64) | success | 5 | 35 | 212 | 1 | 47 | 0 | 6 | 301 |
| [37112204069](https://github.com/Hexpy-Games/butler/actions/runs/37112204069) | Clippy (Linux x64) | success | 3 | 21 | 0 | 145 | 0 | 0 | 4 | 170 |
| [37112204069](https://github.com/Hexpy-Games/butler/actions/runs/37112204069) | Tests (Linux x64) | success | 4 | 30 | 0 | 277 | 0 | 0 | 8 | 315 |
| [37112204069](https://github.com/Hexpy-Games/butler/actions/runs/37112204069) | E2E stub (Linux x64 2/3) | success | 87 | 29 | 0 | 291 | 0 | 0 | 4 | 324 |
| [37112204069](https://github.com/Hexpy-Games/butler/actions/runs/37112204069) | E2E stub (Linux x64 1/3) | success | 94 | 29 | 0 | 436 | 0 | 0 | 3 | 468 |
| [37112204069](https://github.com/Hexpy-Games/butler/actions/runs/37112204069) | E2E stub (Linux x64 3/3) | success | 229 | 71 | 0 | 288 | 0 | 0 | 6 | 365 |
| [37112204069](https://github.com/Hexpy-Games/butler/actions/runs/37112204069) | E2E install (Linux x64 2/2) | success | 231 | 34 | 0 | 133 | 0 | 0 | 6 | 173 |
| [37112204069](https://github.com/Hexpy-Games/butler/actions/runs/37112204069) | E2E install (Linux x64 1/2) | success | 385 | 91 | 0 | 197 | 0 | 0 | 5 | 293 |
| [37112224665](https://github.com/Hexpy-Games/butler/actions/runs/37112224665) | Build Windows Squirrel artifacts | success | 245 | 12 | 67 | 0 | 252 | 764 | 10 | 1105 |
| [37112224665](https://github.com/Hexpy-Games/butler/actions/runs/37112224665) | Verify Windows install update uninstall | success | 3 | 65 | 0 | 306 | 185 | 0 | 5 | 561 |
| [37114589478](https://github.com/Hexpy-Games/butler/actions/runs/37114589478) | Fast Bun unit suite | success | 7 | 20 | 0 | 41 | 0 | 0 | 26 | 87 |
| [37114589479](https://github.com/Hexpy-Games/butler/actions/runs/37114589479) | Check and build the site | success | 3 | 8 | 8 | 9 | 0 | 0 | 3 | 28 |
| [37114589480](https://github.com/Hexpy-Games/butler/actions/runs/37114589480) | no-identity and ad-hoc self-test | success | 9 | 10 | 0 | 0 | 0 | 0 | 16 | 26 |
| [37114589480](https://github.com/Hexpy-Games/butler/actions/runs/37114589480) | shellcheck | success | 3 | 4 | 0 | 0 | 0 | 0 | 2 | 6 |
| [37114589482](https://github.com/Hexpy-Games/butler/actions/runs/37114589482) | Build unsigned Windows preview | success | 3 | 21 | 0 | 1 | 16 | 168 | 8 | 214 |
| [37114589482](https://github.com/Hexpy-Games/butler/actions/runs/37114589482) | Platform contracts and debug stub chat | success | 220 | 38 | 57 | 200 | 22 | 0 | 8 | 325 |
| [37114589482](https://github.com/Hexpy-Games/butler/actions/runs/37114589482) | Installed unsigned Windows preview | cancelled | 2 | 244 | 0 | 41 | 1 | 0 | 161 | 447 |
| [37114589512](https://github.com/Hexpy-Games/butler/actions/runs/37114589512) | licenses | success | 2 | 5 | 0 | 0 | 0 | 0 | 5 | 10 |
| [37114589514](https://github.com/Hexpy-Games/butler/actions/runs/37114589514) | Package and smoke unsigned darwin-arm64 App | cancelled | 7 | 55 | 936 | 0 | 0 | 0 | 31 | 1022 |
| [37114589528](https://github.com/Hexpy-Games/butler/actions/runs/37114589528) | build | success | 3 | 11 | 5 | 46 | 0 | 0 | 26 | 88 |
| [37114589544](https://github.com/Hexpy-Games/butler/actions/runs/37114589544) | Package (linux-arm64) | cancelled | 6 | 30 | 961 | 0 | 0 | 0 | 19 | 1010 |
| [37114589544](https://github.com/Hexpy-Games/butler/actions/runs/37114589544) | Package (linux-x64) | cancelled | 3 | 36 | 958 | 0 | 0 | 0 | 25 | 1019 |
| [37114589636](https://github.com/Hexpy-Games/butler/actions/runs/37114589636) | Lint scripts and dry-run the npm package | success | 3 | 6 | 0 | 0 | 2 | 0 | 1 | 9 |
| [37114589636](https://github.com/Hexpy-Games/butler/actions/runs/37114589636) | Install smoke (darwin-arm64) | cancelled | 30 | 7 | 0 | 0 | 0 | 948 | 34 | 989 |
| [37114589636](https://github.com/Hexpy-Games/butler/actions/runs/37114589636) | Install smoke (linux-x64) | cancelled | 3 | 2 | 0 | 0 | 0 | 980 | 23 | 1005 |
| [37114589636](https://github.com/Hexpy-Games/butler/actions/runs/37114589636) | Install smoke (linux-arm64) | cancelled | 5 | 3 | 0 | 0 | 0 | 977 | 21 | 1001 |
| [37114589668](https://github.com/Hexpy-Games/butler/actions/runs/37114589668) | platform-paths | success | 3 | 4 | 0 | 0 | 0 | 0 | 3 | 7 |
| [37114589668](https://github.com/Hexpy-Games/butler/actions/runs/37114589668) | Windows compile check (x86_64-pc-windows-msvc) | success | 2 | 30 | 0 | 385 | 0 | 0 | 39 | 454 |
| [37114589668](https://github.com/Hexpy-Games/butler/actions/runs/37114589668) | Rust checks (macOS arm64) | cancelled | 89 | 19 | 0 | 1044 | 0 | 0 | 165 | 1228 |
| [37114589672](https://github.com/Hexpy-Games/butler/actions/runs/37114589672) | Tests (Linux x64) | success | 3 | 26 | 0 | 256 | 0 | 0 | 4 | 286 |
| [37114589672](https://github.com/Hexpy-Games/butler/actions/runs/37114589672) | Format and source rules | success | 39 | 12 | 0 | 56 | 0 | 0 | 4 | 72 |
| [37114589672](https://github.com/Hexpy-Games/butler/actions/runs/37114589672) | Clippy (Linux x64) | success | 3 | 21 | 0 | 146 | 0 | 0 | 3 | 170 |
| [37114589672](https://github.com/Hexpy-Games/butler/actions/runs/37114589672) | E2E perf (Linux x64) | cancelled | 3 | 17 | 977 | 0 | 0 | 0 | 29 | 1023 |
| [37114589672](https://github.com/Hexpy-Games/butler/actions/runs/37114589672) | Build E2E archive (Linux x64) | success | 3 | 32 | 198 | 1 | 45 | 0 | 5 | 281 |
| [37114589672](https://github.com/Hexpy-Games/butler/actions/runs/37114589672) | E2E stub (Linux x64 3/3) | success | 3 | 86 | 0 | 233 | 0 | 0 | 5 | 324 |
| [37114589672](https://github.com/Hexpy-Games/butler/actions/runs/37114589672) | E2E install (Linux x64 1/2) | success | 3 | 31 | 0 | 156 | 0 | 0 | 4 | 191 |
| [37114589672](https://github.com/Hexpy-Games/butler/actions/runs/37114589672) | E2E stub (Linux x64 2/3) | success | 3 | 29 | 0 | 285 | 0 | 0 | 3 | 317 |
| [37114589672](https://github.com/Hexpy-Games/butler/actions/runs/37114589672) | E2E stub (Linux x64 1/3) | success | 3 | 52 | 0 | 441 | 0 | 0 | 6 | 499 |
| [37114589672](https://github.com/Hexpy-Games/butler/actions/runs/37114589672) | E2E install (Linux x64 2/2) | success | 3 | 25 | 0 | 140 | 0 | 0 | 3 | 168 |
| [37115518739](https://github.com/Hexpy-Games/butler/actions/runs/37115518739) | build | success | 2 | 8 | 3 | 35 | 0 | 0 | 23 | 69 |
| [37115518750](https://github.com/Hexpy-Games/butler/actions/runs/37115518750) | no-identity and ad-hoc self-test | success | 53 | 8 | 0 | 0 | 0 | 0 | 14 | 22 |
| [37115518750](https://github.com/Hexpy-Games/butler/actions/runs/37115518750) | shellcheck | success | 3 | 4 | 0 | 0 | 0 | 0 | 3 | 7 |
| [37115518759](https://github.com/Hexpy-Games/butler/actions/runs/37115518759) | licenses | success | 3 | 7 | 0 | 0 | 0 | 0 | 6 | 13 |
| [37115518787](https://github.com/Hexpy-Games/butler/actions/runs/37115518787) | Check and build the site | success | 3 | 8 | 4 | 6 | 0 | 0 | 4 | 22 |
| [37115518829](https://github.com/Hexpy-Games/butler/actions/runs/37115518829) | Fast Bun unit suite | success | 52 | 17 | 0 | 29 | 0 | 0 | 4 | 50 |
| [37116604844](https://github.com/Hexpy-Games/butler/actions/runs/37116604844) | Verify Windows install update uninstall | failure | 3 | 58 | 0 | 255 | 0 | 0 | 5 | 318 |
| [37117607706](https://github.com/Hexpy-Games/butler/actions/runs/37117607706) | Verify Windows install update uninstall | failure | 3 | 69 | 0 | 194 | 0 | 0 | 5 | 268 |
