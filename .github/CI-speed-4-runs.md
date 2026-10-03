# Draft PR #489 measurements

Baseline tables are in [CI-speed-4.md](CI-speed-4.md). All values below are seconds.

## First completed cold experiment (`fe5f1d01aa6a`)

This run optimized every workspace test binary; it is superseded by the configuration-preserving split. It is not a successful speedup or a green qualification.

| Workflow | Run | Result | Wall |
| --- | --- | --- | ---: |
| Rust quality | [37118670026](https://github.com/Hexpy-Games/butler/actions/runs/37118670026) | failure | 5841 |
| Unsigned Windows preview smoke | [37118669600](https://github.com/Hexpy-Games/butler/actions/runs/37118669600) | success | 2632 |
| Post-merge CI | [37118669628](https://github.com/Hexpy-Games/butler/actions/runs/37118669628) | success | 695 |

Failures: the consolidated hygiene child selector lacked its module prefix (both platforms); Linux PERF-IDLE exceeded the unchanged 100,000,000-byte memory budget; macOS Settings update fixtures unexpectedly rebuilt .90/.91 without protoc. The gate failed closed.

The qualified child selector passes all five local hygiene checks. The workflow now preserves the original debug workspace and production/perf configurations. Existing prebuilt update-fixture inputs consume real .90/.91 binaries built in the producer, retaining embedded-version and every update/signature/data assertion.

PERF-IDLE observed RSS 102,555,648 B, PSS 98,789,376 B, read-character delta 55,157 B and physical reads 0 B at the first full window. Later assertions were not reached. It is recorded on [existing issue #450](https://github.com/Hexpy-Games/butler/issues/450#issuecomment-5968876744); no cause or fix is claimed from this sample. The issue is linked in [the PR comment](https://github.com/Hexpy-Games/butler/pull/489#issuecomment-5969284743) before the next code push.

The three serial Linux perf shards passed in 124/132/125 s (including setup). Session-view p95 was 16.295 ms against the unchanged 150 ms gate and 50 ms target. Full macOS PERF-IDLE passed its three original windows; this does not erase the Linux failure.

Cargo snapshots: x64 1,319,959,882 B; ARM64 1,687,818,243 B; macOS 1,572,488,049 B. The x64 and ARM64 caches were evicted during macOS compilation. Repository cache usage was 10,515,426,044 B. Successful build outputs now also have a two-day artifact fallback; complete checksummed snapshots are restored only from successful compatible native producers, then Cargo validates current sources.

macOS cold build took 65m01s after 11m57s of Clippy. Optimizing all workspace unit-test binaries accounted for a final 21-minute memory-test compile tail. The revised graph leaves workspace unit tests in their original debug profile and optimizes only the performance E2E archive.

## Cold job phases

Queue excludes needs wait. Workflow wall above includes all dependencies and queueing. Composite steps are shown as Mixed; no invented substep timing is reported.

| Job | Result | Queue | Setup/cache | Build | Test | Upload | Mixed | Other | Wall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| changes | success | 3 | 4 | 0 | 0 | 0 | 0 | 5 | 9 |
| Clippy (Linux x64) | success | 3 | 27 | 0 | 433 | 0 | 0 | 16 | 476 |
| macos-archive / Build archives (darwin-arm64) | success | 112 | 57 | 3902 | 746 | 18 | 0 | 68 | 4791 |
| site / Check and build the site | success | 3 | 12 | 8 | 9 | 0 | 0 | 3 | 32 |
| Format and source rules | success | 75 | 14 | 0 | 55 | 0 | 0 | 3 | 72 |
| linux-arm64-archive / Build archives (linux-arm64) | success | 40 | 38 | 1752 | 409 | 16 | 0 | 25 | 2240 |
| linux-archive / Build archives (linux-x64) | success | 27 | 30 | 1769 | 117 | 13 | 0 | 21 | 1950 |
| ui / Fast Bun unit suite | success | 10 | 25 | 0 | 42 | 0 | 0 | 25 | 92 |
| ds / build | success | 3 | 15 | 5 | 46 | 0 | 0 | 31 | 97 |
| linux-tests / Performance (linux-x64 3) | success | 3 | 11 | 0 | 0 | 0 | 109 | 4 | 124 |
| linux-tests / Performance (linux-x64 2) | success | 4 | 17 | 0 | 0 | 0 | 110 | 5 | 132 |
| linux-tests / Performance (linux-x64 idle) | failure | 3 | 11 | 0 | 0 | 0 | 204 | 3 | 218 |
| linux-tests / Performance (linux-x64 1) | success | 3 | 11 | 0 | 0 | 0 | 110 | 4 | 125 |
| linux-tests / E2E (linux-x64 3) | success | 3 | 20 | 0 | 0 | 0 | 92 | 7 | 119 |
| linux-tests / E2E (linux-x64 install) | success | 3 | 10 | 0 | 0 | 0 | 32 | 4 | 46 |
| linux-tests / E2E (linux-x64 4) | failure | 3 | 13 | 0 | 0 | 0 | 136 | 3 | 152 |
| linux-tests / E2E (linux-x64 ins-02) | success | 4 | 19 | 0 | 0 | 0 | 21 | 5 | 45 |
| linux-tests / E2E (linux-x64 5) | success | 3 | 11 | 0 | 0 | 0 | 98 | 5 | 114 |
| linux-tests / E2E (linux-x64 ins-14) | success | 3 | 12 | 0 | 0 | 0 | 49 | 3 | 64 |
| linux-tests / E2E (linux-x64 1) | success | 3 | 12 | 0 | 0 | 0 | 114 | 4 | 130 |
| linux-tests / workspace | success | 28 | 21 | 11 | 0 | 0 | 0 | 5 | 37 |
| install-x64 / Lint scripts and dry-run the npm package | success | 3 | 5 | 0 | 0 | 2 | 0 | 3 | 10 |
| linux-tests / E2E (linux-x64 2) | success | 39 | 9 | 0 | 0 | 0 | 147 | 4 | 160 |
| linux-tests / E2E (linux-x64 6) | success | 16 | 32 | 0 | 0 | 0 | 122 | 9 | 163 |
| linux-package-x64 / Package (linux-x64) | success | 50 | 29 | 112 | 0 | 11 | 0 | 9 | 161 |
| install-x64 / Install smoke (linux-x64) | success | 39 | 6 | 0 | 26 | 1 | 73 | 4 | 110 |
| linux-package-x64 / Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 3 | 20 | 0 | 0 | 0 | 0 | 33 | 53 |
| linux-package-x64 / Install smoke (debian:trixie, linux-x64 deb) | success | 3 | 12 | 0 | 0 | 0 | 0 | 33 | 45 |
| linux-package-x64 / Install smoke (ubuntu:24.04, linux-x64 deb) | success | 4 | 13 | 0 | 0 | 0 | 0 | 40 | 53 |
| linux-package-arm64 / Package (linux-arm64) | success | 5 | 31 | 81 | 0 | 5 | 0 | 9 | 126 |
| install-arm64 / Lint scripts and dry-run the npm package | success | 3 | 4 | 0 | 1 | 3 | 0 | 4 | 12 |
| install-arm64 / Install smoke (linux-arm64) | success | 5 | 4 | 0 | 36 | 0 | 44 | 7 | 91 |
| linux-package-arm64 / Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 5 | 6 | 0 | 0 | 0 | 0 | 38 | 44 |
| macos-tests / Performance (darwin-arm64 2) | success | 80 | 30 | 0 | 0 | 0 | 111 | 7 | 148 |
| macos-tests / E2E (darwin-arm64 4) | failure | 8 | 19 | 0 | 0 | 0 | 122 | 6 | 147 |
| macos-tests / Performance (darwin-arm64 3) | success | 301 | 13 | 0 | 0 | 0 | 128 | 5 | 146 |
| macos-tests / Performance (darwin-arm64 1) | success | 426 | 17 | 0 | 0 | 0 | 121 | 6 | 144 |
| macos-tests / E2E (darwin-arm64 5) | success | 9 | 33 | 0 | 0 | 0 | 157 | 13 | 203 |
| macos-package / Package and smoke unsigned darwin-arm64 App | failure | 140 | 38 | 118 | 513 | 0 | 0 | 8 | 677 |
| macos-tests / Performance (darwin-arm64 idle) | success | 480 | 15 | 0 | 0 | 0 | 377 | 5 | 397 |
| macos-tests / E2E (darwin-arm64 ins-02) | success | 10 | 15 | 0 | 0 | 0 | 42 | 5 | 62 |
| macos-tests / E2E (darwin-arm64 2) | success | 235 | 16 | 0 | 0 | 0 | 162 | 5 | 183 |
| macos-tests / E2E (darwin-arm64 3) | success | 162 | 10 | 0 | 0 | 0 | 109 | 6 | 125 |
| macos-tests / workspace | success | 221 | 15 | 22 | 0 | 0 | 0 | 3 | 40 |
| macos-tests / E2E (darwin-arm64 install) | success | 455 | 31 | 0 | 0 | 0 | 44 | 6 | 81 |
| macos-tests / E2E (darwin-arm64 1) | success | 297 | 15 | 0 | 0 | 0 | 126 | 5 | 146 |
| macos-tests / E2E (darwin-arm64 ins-14) | success | 268 | 17 | 0 | 0 | 0 | 4 | 5 | 26 |
| install-macos / Lint scripts and dry-run the npm package | success | 4 | 5 | 0 | 0 | 2 | 0 | 2 | 9 |
| macos-tests / E2E (darwin-arm64 6) | success | 579 | 29 | 0 | 0 | 0 | 188 | 8 | 225 |
| install-macos / Install smoke (darwin-arm64) | success | 436 | 5 | 0 | 73 | 1 | 86 | 22 | 187 |
| install-merge / Merge per-platform manifests | success | 3 | 8 | 0 | 0 | 0 | 0 | 3 | 11 |
| gate | failure | 2 | 3 | 0 | 0 | 0 | 0 | 5 | 8 |
| Build unsigned Windows preview | success | 266 | 13 | 0 | 1 | 20 | 774 | 8 | 816 |
| Platform contracts and debug stub chat | success | 1085 | 21 | 358 | 286 | 22 | 0 | 8 | 695 |
| Installed unsigned Windows preview | success | 4 | 266 | 0 | 453 | 1 | 0 | 127 | 847 |
| platform-paths | success | 3 | 3 | 0 | 1 | 0 | 0 | 3 | 7 |
| Windows compile check (x86_64-pc-windows-msvc) | success | 3 | 31 | 0 | 376 | 0 | 0 | 43 | 450 |

## Producer bootstrap (`bf40657e3434`)

The archive jobs failed because `nextest archive` does not accept `-j`; Cargo's
job limit now uses `CARGO_BUILD_JOBS=8`. The corrected archive command and the
five hygiene tests replayed from that archive pass locally. This failed Rust
run is not a qualification or a speedup claim. Valid production producers
were allowed to finish and publish reusable build inputs before the fix push.

Windows preview [37124231972](https://github.com/Hexpy-Games/butler/actions/runs/37124231972)
passed in **1270 s (21m10s)**, versus the historical successful median
1411 s (23m31s). Production build took 179 s, debug contracts 282 s, and the
complete hosted installed verification 801 s. Those are job walls including
setup/upload, with every existing Windows check retained. This is a 10.0%
observed workflow reduction; hosted/self-hosted contention can vary.

The hosted job's serial command (184 s), LAN/pairing (219 s) and supervision
(127 s) groups exposed another avoidable chain. The next code run puts these
remote/recovery/data checks on independent disposable runners. The command
matrix consumes the installed release through BUTLER_E2E_INSTALLED_ROOT, so
it remains with installed UI/lifecycle/Task Scheduler checks and their real
dependency. The complete 12-harness assertion is now a
cross-job gate over completion artifacts and every selected job result.

The additional SDK artifact fallback preserves the recipe's required relative
links and every pinned input. Existing cache quota eviction cannot silently
turn it into an unchecked or partial runtime.

An isolated local PERF-IDLE probe used the verified production Agent from this
run and the local archive. It failed at the first full window: RSS 106,393,600 B,
PSS 102,378,496 B, read-character delta 55,157 B, physical reads 0 B. The original
100,000,000-byte gate remained enforced; later windows/assertions were not
reached. This WSL measurement is not a hosted-CI result and does not establish
a cause. Restoring the production profile alone has not proven a memory fix.

## Corrected producer trial (`6a6ca69de6d0`)

Main is preview.8 (`1bf694a91`) in this trial; its additional checks are retained.
This is still **not a green Rust qualification**: ordinary archives lacked the
normal debug CLI, and native macOS cache extraction rejected a BSD-tar root
AppleDouble sidecar. Producers now build all targets together, inventory the
existing archive, suppress new sidecars, and safely preserve validated legacy
root attributes inside the cache subtree. A real macOS Cargo snapshot restored
6,753 entries; the real SDK restored 50,717 entries and passed the unchanged
recipe adoption/digest/build-setting checks locally.

| Workflow | Run | Result | Wall (s) |
| --- | --- | --- | ---: |
| Rust quality | [37128014277](https://github.com/Hexpy-Games/butler/actions/runs/37128014277) | failure | 1589 |
| Unsigned Windows preview smoke | [37128013956](https://github.com/Hexpy-Games/butler/actions/runs/37128013956) | success | 1472 |
| Post-merge CI | [37128013976](https://github.com/Hexpy-Games/butler/actions/runs/37128013976) | success | 469 |

Windows completed all 12 original compiled harnesses plus installed UI,
lifecycle and Task Scheduler checks. Its main hosted job fell from 801 s to
471 s (41.2%); new main adds command-observation cases, so this is not a
controlled identical-input comparison. Actual workflow wall was **1472 s
(24m32s)**, with 336 s initial native queue and an additional native-runner
wait between build and contracts. Historical successful median is 1411 s;
this queued wall is **not** claimed as a successful workflow speedup.

Linux perf passed all three shards and the complete idle scenario. Session-view
p95 was **9.275 ms**, against the original 150 ms gate. All three full idle
windows asserted complete seeded state: RSS 98,947,072 / 98,959,360 / 98,967,552 B;
read-character delta 55,157 B per window and physical reads 0 B. This hosted
pass does not explain or erase the earlier WSL/experimental failures.

| Job | Result | Queue | Setup/cache | Build | Test | Upload | Mixed | Other | Wall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| changes | success | 3 | 5 | 0 | 0 | 0 | 0 | 3 | 8 |
| Clippy (Linux x64) | success | 10 | 27 | 0 | 449 | 0 | 0 | 15 | 491 |
| Format and source rules | success | 3 | 12 | 0 | 55 | 0 | 0 | 3 | 70 |
| linux-arm64-archive / Build archives (linux-arm64) | failure | 5 | 34 | 395 | 387 | 0 | 0 | 4 | 820 |
| linux-native / Build native Agent (linux-x64) | success | 3 | 84 | 460 | 1 | 16 | 0 | 22 | 583 |
| linux-arm64-native / Build native Agent (linux-arm64) | success | 15 | 86 | 419 | 1 | 16 | 0 | 22 | 544 |
| linux-archive / Build archives (linux-x64) | failure | 3 | 27 | 503 | 31 | 0 | 0 | 3 | 564 |
| linux-perf-archive / Build perf harness (linux-x64) | success | 76 | 33 | 184 | 0 | 3 | 0 | 11 | 231 |
| site / Check and build the site | success | 3 | 8 | 8 | 10 | 0 | 0 | 8 | 34 |
| macos-native / Build native Agent (darwin-arm64) | failure | 47 | 1403 | 0 | 0 | 0 | 0 | 9 | 1412 |
| macos-perf-archive / Build perf harness (darwin-arm64) | success | 453 | 28 | 218 | 0 | 6 | 0 | 37 | 289 |
| macos-archive / Build archives (darwin-arm64) | failure | 749 | 21 | 373 | 387 | 0 | 0 | 4 | 785 |
| ds / build | success | 3 | 11 | 6 | 45 | 0 | 0 | 39 | 101 |
| ui / Fast Bun unit suite | success | 1283 | 19 | 0 | 35 | 0 | 0 | 25 | 79 |
| linux-package-arm64 / Package (linux-arm64) | success | 4 | 29 | 72 | 0 | 4 | 0 | 7 | 112 |
| install-arm64 / Lint scripts and dry-run the npm package | success | 3 | 6 | 0 | 2 | 2 | 0 | 5 | 15 |
| install-arm64 / Install smoke (linux-arm64) | success | 5 | 3 | 0 | 33 | 1 | 42 | 6 | 85 |
| linux-perf / Performance (linux-x64 1) | success | 2 | 9 | 0 | 0 | 0 | 89 | 3 | 101 |
| linux-perf / Performance (linux-x64 idle) | success | 3 | 14 | 0 | 0 | 0 | 323 | 5 | 342 |
| linux-perf / Performance (linux-x64 2) | success | 3 | 15 | 0 | 0 | 0 | 92 | 5 | 112 |
| linux-perf / Performance (linux-x64 3) | success | 3 | 16 | 0 | 0 | 0 | 101 | 5 | 122 |
| linux-package-x64 / Package (linux-x64) | success | 4 | 38 | 114 | 0 | 13 | 0 | 11 | 176 |
| install-x64 / Lint scripts and dry-run the npm package | success | 3 | 3 | 0 | 2 | 3 | 0 | 2 | 10 |
| install-x64 / Install smoke (linux-x64) | success | 2 | 5 | 0 | 30 | 1 | 71 | 6 | 113 |
| linux-package-arm64 / Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 5 | 7 | 0 | 0 | 0 | 0 | 39 | 46 |
| linux-package-x64 / Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 2 | 10 | 0 | 0 | 0 | 0 | 35 | 45 |
| linux-package-x64 / Install smoke (debian:trixie, linux-x64 deb) | success | 2 | 10 | 0 | 0 | 0 | 0 | 35 | 45 |
| linux-package-x64 / Install smoke (ubuntu:24.04, linux-x64 deb) | success | 2 | 10 | 0 | 0 | 0 | 0 | 35 | 45 |
| gate | failure | 3 | 4 | 0 | 0 | 0 | 0 | 2 | 6 |
| Platform contracts and debug stub chat | success | 698 | 16 | 66 | 180 | 21 | 0 | 8 | 291 |
| Build unsigned Windows preview | success | 336 | 17 | 0 | 0 | 21 | 252 | 8 | 298 |
| Hosted Windows E2E (remote) | success | 4 | 19 | 1 | 0 | 0 | 0 | 152 | 172 |
| Installed unsigned Windows preview | success | 3 | 318 | 1 | 23 | 1 | 0 | 128 | 471 |
| Hosted Windows E2E (data) | success | 2 | 15 | 1 | 0 | 0 | 0 | 48 | 64 |
| Hosted Windows E2E (recovery) | success | 2 | 13 | 1 | 0 | 0 | 0 | 148 | 162 |
| Complete Windows preview verification | success | 3 | 1 | 0 | 0 | 0 | 0 | 5 | 6 |

## Next measurement

Main advanced to `1bf694a91` before the next push. Its product changes remain
unchanged; conflicts were resolved by retaining shared producer inputs and all
new packaged visual/update checks. New standalone scenarios were added to the
single E2E binary. The updated compiled inventory is **312 tests, 14 existing
ignored**; ordinary shards contain 48/49/50/48/49/48 tests, install groups
1/1/14, perf groups 12/17/19 plus the full idle observation. All six invariants,
format, touched-crate Clippy, source rules and frozen Bun/full check pass after
the merge.

The subsequent code push checks the corrected selector, verified embedded versions, original build configurations and artifact cache fallback. Its complete workflow wall times and results will be added to the draft PR. No release tag or post-release dispatch is authorized by this task, so release-after numbers remain estimates, not observations.

## Complete archive trial (`35fa02f481e4`)

This trial completed with **Rust failure**, not a green qualification. Windows
passed in **807 s (13m27s)**, 42.8% below its historical successful median
1411 s. Post-merge CI passed in **466 s (7m46s)**; its native macOS/ARM
coverage is now counted in the shared Rust graph, not removed. Rust quality
finished in **2871 s (47m51s)**. All producer, workspace, Linux ordinary/perf,
package/install, Bun, DS and site checks passed. macOS App packaging passed
all preview.6 comparisons, onboarding, update-choice/work-stream checks,
packaged smoke, real .90/.91 Settings updates and existing layout smoke.

Linux p95 was **9.833 ms**. All complete idle windows passed with RSS
97,140,736 / 97,148,928 / 97,165,312 B; each window read 55,157 characters and
0 physical bytes. All original gates and complete-state assertions remained.

Failures were macOS daily strict replay (the legitimate scheduled briefing
was missing after every vector/one-load assertion passed), an embedding-query
deadline in historical-generation recall, and the existing 180 s owner-scale
posting-query watchdog. The new graph forced eight threads on small runners;
the original CPU-based default is restored, capped at eight. The daily cassette
now includes the scheduled request and asserts the full stored briefing,
including ordered suggestions, all headlines and real scheduled provenance.
All nine memory E2Es pass locally against this run's unchanged debug Agent;
strict replay, vector retrieval, original deadlines and budgets remain enforced.
The replay failure is linked to existing [#432](https://github.com/Hexpy-Games/butler/issues/432).
Concurrency corrections still require a changed-source hosted qualification.

Native macOS setup including SDK/Cargo restore took 142 s, production 698 s
and real update variants 519 s. Unchanged workspace crates still recompiled after checkout.
Cargo snapshots now include full-content identities for every tracked input;
only identical inputs regain producer timestamps. Changed Rust, included data
and build-script environment values all rebuild in a real Cargo freshness
proof. Seven trust/cache/gate/coverage invariants pass; legacy snapshots without
source identities receive no timestamp restoration. This improvement will
bootstrap new compatible snapshots; no release-after result is claimed.

| Job | Result | Queue | Setup/cache | Build | Test | Upload | Mixed | Other | Wall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| changes | success | 3 | 5 | 0 | 0 | 0 | 0 | 41 | 46 |
| Clippy (Linux x64) | success | 3 | 28 | 0 | 442 | 0 | 0 | 11 | 481 |
| Format and source rules | success | 4 | 12 | 0 | 44 | 0 | 0 | 2 | 58 |
| linux-arm64-native / Build native Agent (linux-arm64) | success | 8 | 74 | 405 | 1 | 11 | 0 | 16 | 507 |
| linux-native / Build native Agent (linux-x64) | success | 3 | 53 | 314 | 0 | 11 | 0 | 15 | 393 |
| linux-archive / Build archives (linux-x64) | success | 2 | 41 | 521 | 19 | 26 | 0 | 21 | 628 |
| linux-arm64-archive / Build archives (linux-arm64) | success | 6 | 45 | 415 | 432 | 21 | 0 | 18 | 931 |
| linux-perf-archive / Build perf harness (linux-x64) | success | 14 | 40 | 69 | 0 | 7 | 0 | 12 | 128 |
| macos-perf-archive / Build perf harness (darwin-arm64) | success | 6 | 25 | 58 | 0 | 3 | 0 | 3 | 89 |
| site / Check and build the site | success | 3 | 9 | 8 | 10 | 0 | 0 | 8 | 35 |
| macos-archive / Build archives (darwin-arm64) | success | 7 | 45 | 287 | 250 | 34 | 0 | 34 | 650 |
| macos-native / Build native Agent (darwin-arm64) | success | 10 | 162 | 1217 | 2 | 30 | 0 | 55 | 1466 |
| ui / Fast Bun unit suite | success | 8 | 24 | 0 | 38 | 0 | 0 | 6 | 68 |
| ds / build | success | 3 | 13 | 5 | 39 | 0 | 0 | 62 | 119 |
| linux-perf / Performance (linux-x64 1) | success | 2 | 7 | 0 | 0 | 0 | 104 | 4 | 115 |
| linux-perf / Performance (linux-x64 2) | success | 2 | 7 | 0 | 0 | 0 | 92 | 6 | 105 |
| linux-perf / Performance (linux-x64 3) | success | 3 | 18 | 0 | 0 | 0 | 93 | 5 | 116 |
| linux-perf / Performance (linux-x64 idle) | success | 3 | 13 | 0 | 0 | 0 | 329 | 6 | 348 |
| install-x64 / Lint scripts and dry-run the npm package | success | 3 | 4 | 0 | 1 | 2 | 0 | 2 | 9 |
| linux-package-x64 / Package (linux-x64) | success | 3 | 34 | 125 | 0 | 14 | 0 | 27 | 200 |
| install-x64 / Install smoke (linux-x64) | success | 2 | 4 | 0 | 31 | 1 | 76 | 4 | 116 |
| linux-package-arm64 / Package (linux-arm64) | success | 16 | 43 | 80 | 0 | 5 | 0 | 9 | 137 |
| install-arm64 / Lint scripts and dry-run the npm package | success | 3 | 5 | 0 | 1 | 3 | 0 | 3 | 12 |
| install-arm64 / Install smoke (linux-arm64) | success | 7 | 4 | 0 | 33 | 1 | 39 | 32 | 109 |
| linux-package-x64 / Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 3 | 9 | 0 | 0 | 0 | 0 | 31 | 40 |
| linux-package-x64 / Install smoke (ubuntu:24.04, linux-x64 deb) | success | 34 | 9 | 0 | 0 | 0 | 0 | 34 | 43 |
| linux-package-x64 / Install smoke (debian:trixie, linux-x64 deb) | success | 46 | 9 | 0 | 0 | 0 | 0 | 32 | 41 |
| linux-tests / workspace | success | 40 | 23 | 35 | 0 | 0 | 0 | 3 | 61 |
| linux-tests / E2E (linux-x64 ins-02) | success | 17 | 15 | 0 | 0 | 0 | 154 | 3 | 172 |
| linux-tests / E2E (linux-x64 3) | success | 58 | 16 | 0 | 0 | 0 | 226 | 3 | 245 |
| linux-tests / E2E (linux-x64 1) | success | 89 | 14 | 0 | 0 | 0 | 137 | 4 | 155 |
| linux-tests / E2E (linux-x64 ins-14) | success | 128 | 15 | 0 | 0 | 0 | 171 | 4 | 190 |
| linux-tests / E2E (linux-x64 2) | success | 105 | 13 | 0 | 0 | 0 | 273 | 3 | 289 |
| linux-tests / E2E (linux-x64 4) | success | 163 | 14 | 0 | 0 | 0 | 159 | 4 | 177 |
| linux-tests / E2E (linux-x64 5) | success | 104 | 16 | 0 | 0 | 0 | 162 | 5 | 183 |
| linux-tests / E2E (linux-x64 install) | success | 191 | 17 | 0 | 0 | 0 | 154 | 4 | 175 |
| linux-tests / E2E (linux-x64 6) | success | 246 | 17 | 0 | 0 | 0 | 249 | 4 | 270 |
| macos-tests / workspace | success | 60 | 35 | 33 | 0 | 0 | 0 | 7 | 75 |
| macos-tests / E2E (darwin-arm64 ins-02) | success | 680 | 37 | 0 | 0 | 0 | 140 | 9 | 186 |
| macos-tests / E2E (darwin-arm64 3) | success | 448 | 23 | 0 | 0 | 0 | 189 | 11 | 223 |
| macos-tests / E2E (darwin-arm64 4) | failure | 680 | 23 | 0 | 0 | 0 | 188 | 6 | 217 |
| macos-tests / E2E (darwin-arm64 6) | success | 872 | 23 | 0 | 0 | 0 | 147 | 2 | 172 |
| macos-tests / E2E (darwin-arm64 ins-14) | success | 828 | 24 | 0 | 0 | 0 | 6 | 6 | 36 |
| macos-tests / E2E (darwin-arm64 install) | success | 1054 | 38 | 0 | 0 | 0 | 160 | 8 | 206 |
| macos-tests / E2E (darwin-arm64 1) | success | 1270 | 40 | 0 | 0 | 0 | 184 | 7 | 231 |
| macos-tests / E2E (darwin-arm64 5) | failure | 1095 | 13 | 0 | 0 | 0 | 183 | 8 | 204 |
| macos-tests / E2E (darwin-arm64 2) | failure | 1307 | 35 | 0 | 0 | 0 | 211 | 7 | 253 |
| linux-package-arm64 / Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 13 | 6 | 0 | 0 | 0 | 0 | 31 | 37 |
| macos-perf / Performance (darwin-arm64 2) | success | 748 | 19 | 0 | 0 | 0 | 123 | 9 | 151 |
| macos-perf / Performance (darwin-arm64 3) | success | 751 | 32 | 0 | 0 | 0 | 158 | 9 | 199 |
| macos-perf / Performance (darwin-arm64 1) | success | 873 | 29 | 0 | 0 | 0 | 125 | 7 | 161 |
| macos-perf / Performance (darwin-arm64 idle) | success | 907 | 31 | 0 | 0 | 0 | 393 | 7 | 431 |
| macos-package / Package and smoke unsigned darwin-arm64 App | success | 54 | 39 | 144 | 605 | 0 | 0 | 22 | 810 |
| install-macos / Lint scripts and dry-run the npm package | success | 3 | 4 | 0 | 1 | 3 | 0 | 4 | 12 |
| install-macos / Install smoke (darwin-arm64) | success | 71 | 6 | 0 | 76 | 2 | 73 | 26 | 183 |
| install-merge / Merge per-platform manifests | success | 3 | 8 | 0 | 0 | 0 | 0 | 2 | 10 |
| gate | failure | 2 | 3 | 0 | 0 | 0 | 0 | 2 | 5 |
| Platform contracts and debug stub chat | success | 3 | 10 | 18 | 152 | 16 | 0 | 8 | 204 |
| Build unsigned Windows preview | success | 209 | 10 | 0 | 1 | 11 | 138 | 8 | 168 |
| Hosted Windows E2E (remote) | success | 3 | 14 | 1 | 0 | 0 | 0 | 148 | 163 |
| Hosted Windows E2E (data) | success | 3 | 15 | 0 | 0 | 0 | 0 | 50 | 65 |
| Hosted Windows E2E (recovery) | success | 3 | 14 | 0 | 0 | 0 | 0 | 127 | 141 |
| Installed unsigned Windows preview | success | 2 | 242 | 0 | 25 | 1 | 0 | 135 | 403 |
| Complete Windows preview verification | success | 17 | 2 | 0 | 2 | 0 | 0 | 3 | 7 |
| platform-paths | success | 3 | 4 | 0 | 1 | 0 | 0 | 3 | 8 |
| Windows compile check (x86_64-pc-windows-msvc) | success | 3 | 30 | 0 | 385 | 0 | 0 | 36 | 451 |

## Source-freshness bootstrap (`4e798ccb063a`)

[Rust run 37134711330](https://github.com/Hexpy-Games/butler/actions/runs/37134711330)
is not a qualification: ARM64 archive restore failed before compilation.
Supplementing a partial Actions cache encountered an existing hardlink;
Python 3.12 attempted a backwards seek in the streamed tar. The extractor now
replaces only validated in-tree hardlink destinations. Its full snapshot
round-trip covers an already populated cache, and existing symlink parents
cannot redirect extraction outside the cache subtree. All eight invariants
pass with CI's Python 3.12 and the compiled 312-test inventory.

The earlier macOS strict replay, historical vector recall and 180 s posting
query cases all pass on this changed source. Their full ordinary shards
(4/5/2) pass; no assertion or deadline changed. macOS native and ordinary
archive producers finished successfully and saved complete source identities
before the next correction push. Remaining consumers of this failed trial
can be superseded by the changed-source qualification; cancellation is not
a successful wall-time measurement. The final graph still runs every check.

Release lookup now uses a small identity manifest before transferring any
complete Agent. The eighth invariant proves actual checkout SHA matching
even when PR head metadata differs, incompatible-manifest rejection without
payload transfer, and rejection of a matching corrupt payload. Actual binary
digest and executable-version checks remain mandatory. No release is tagged
or dispatched here; release-after measurements remain unobserved.

## First complete green qualification (`88a462e09eee`)

Every selected check passed on this head. The three prior ordinary macOS
failures passed in the full unchanged-deadline shards; all packaged preview.6
comparison/onboarding/update-choice/workstream, Settings update, layout,
renderer, distro install/reinstall, workspace, Clippy and performance checks
completed. Windows completed all 12 original harnesses and its final gate.

| Workflow | Run | Result | Wall |
| --- | --- | --- | ---: |
| Rust quality | [37137100315](https://github.com/Hexpy-Games/butler/actions/runs/37137100315) | success | 2559 |
| Unsigned Windows preview smoke | [37137100037](https://github.com/Hexpy-Games/butler/actions/runs/37137100037) | success | 893 |
| Post-merge CI | [37137100028](https://github.com/Hexpy-Games/butler/actions/runs/37137100028) | success | 461 |

Linux Rust coverage completed **814 s (13m34s)** after run creation, versus
1478 s (24m38s) historical median, **44.9% lower observed wall**. Windows took
**893 s (14m53s)** versus 1411 s (23m31s), **36.7% lower**. The complete shared
Rust gate took **2559 s (42m39s)**. macOS App coverage took **2546 s (42m26s)**,
**6.6% longer** than its historical 2388 s median. These are observational
comparisons: newer main adds checks and runner contention differs.

The macOS production build took 439 s; the real .90/.91 fixture builds took
594 s, in sequence. The producer's total was 1348 s (22m28s). App packaging
then queued **446 s (7m26s)** before **701 s (11m41s)** of complete checks.
A macOS ordinary shard queued 741 s. The optimized E2E build reused all 5668
unchanged tracked inputs and compiled in 0.43 s; native/debug logs still
recompiled gateway because its watched wallpaper directory's checkout mtime
was new. A real Cargo reproduction reports `Dirty ... the file watched has
changed` despite matching every file. The corrected proof also covers complete
directory membership and all descendant contents. It retains rebuilds for
untracked additions, tracked deletions, changed source/data and environment
inputs; all eight invariants pass in 1.739 s on Python 3.12.

The next graph starts the two real update-fixture builds alongside production
Agent builds. Only App update verification needs both producers; native
perf/install no longer wait for the fixtures. Each of the three real versions
is still built exactly once on the same checkout. Both producers verify the
complete SDK; only one uploads its shared runtime snapshot. The added producer
is required by the final gate. This change and directory proof are not yet a
measured improvement; the next changed-source run will qualify them.

Linux session-view p95: **9.561 ms**. Idle RSS: **96,149,504 / 96,161,792 /
96,206,848 B**, read-character delta **55,157 B** each, physical reads **0 B**.
macOS p95: **4.374 ms**. All three idle windows had RSS **73,007,104 B**,
footprint **37,488,256 B**, physical reads **0 B**. Complete correctness/latest
state assertions and all original budgets passed. This does not erase the
previous WSL 106,393,600 B observation on existing issue #450.

### Green qualification job phases

Seconds; queue excludes dependency waits. Mixed steps retain their aggregate
metadata time. No work or missing substep time is hidden.

| Job | Result | Queue | Setup/cache | Build | Test | Upload | Mixed | Other | Wall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| changes | success | 3 | 3 | 0 | 0 | 0 | 0 | 4 | 7 |
| Format and source rules | success | 3 | 12 | 0 | 56 | 0 | 0 | 2 | 70 |
| Clippy (Linux x64) | success | 3 | 29 | 0 | 375 | 0 | 0 | 11 | 415 |
| linux-perf-archive / Build perf harness (linux-x64) | success | 3 | 39 | 10 | 0 | 3 | 0 | 11 | 63 |
| linux-arm64-native / Build native Agent (linux-arm64) | success | 5 | 65 | 247 | 1 | 8 | 0 | 14 | 335 |
| macos-native / Build native Agent (darwin-arm64) | success | 10 | 251 | 1005 | 3 | 37 | 0 | 52 | 1348 |
| linux-archive / Build archives (linux-x64) | success | 3 | 78 | 83 | 20 | 27 | 0 | 25 | 233 |
| site / Check and build the site | success | 3 | 12 | 8 | 10 | 0 | 0 | 3 | 33 |
| linux-native / Build native Agent (linux-x64) | success | 4 | 93 | 278 | 1 | 17 | 0 | 21 | 410 |
| macos-perf-archive / Build perf harness (darwin-arm64) | success | 7 | 35 | 17 | 0 | 3 | 0 | 21 | 76 |
| macos-archive / Build archives (darwin-arm64) | success | 12 | 280 | 171 | 112 | 45 | 0 | 6 | 614 |
| linux-arm64-archive / Build archives (linux-arm64) | success | 6 | 100 | 151 | 144 | 22 | 0 | 18 | 435 |
| ds / build | success | 4 | 16 | 6 | 45 | 0 | 0 | 34 | 101 |
| ui / Fast Bun unit suite | success | 91 | 28 | 0 | 36 | 0 | 0 | 10 | 74 |
| linux-tests / workspace | success | 4 | 59 | 24 | 0 | 0 | 0 | 8 | 91 |
| linux-tests / E2E (linux-x64 2) | success | 3 | 34 | 0 | 0 | 0 | 211 | 3 | 248 |
| linux-tests / E2E (linux-x64 4) | success | 3 | 14 | 0 | 0 | 0 | 172 | 3 | 189 |
| linux-tests / E2E (linux-x64 3) | success | 14 | 26 | 0 | 0 | 0 | 155 | 6 | 187 |
| linux-tests / E2E (linux-x64 install) | success | 3 | 14 | 0 | 0 | 0 | 158 | 4 | 176 |
| linux-tests / E2E (linux-x64 1) | success | 80 | 14 | 0 | 0 | 0 | 221 | 3 | 238 |
| linux-tests / E2E (linux-x64 ins-14) | success | 3 | 28 | 0 | 0 | 0 | 150 | 5 | 183 |
| linux-tests / E2E (linux-x64 6) | success | 3 | 11 | 0 | 0 | 0 | 240 | 3 | 254 |
| linux-tests / E2E (linux-x64 5) | success | 98 | 33 | 0 | 0 | 0 | 180 | 6 | 219 |
| linux-tests / E2E (linux-x64 ins-02) | success | 35 | 13 | 0 | 0 | 0 | 155 | 4 | 172 |
| install-arm64 / Lint scripts and dry-run the npm package | success | 2 | 3 | 0 | 1 | 3 | 0 | 3 | 10 |
| linux-package-arm64 / Package (linux-arm64) | success | 16 | 28 | 79 | 0 | 5 | 0 | 7 | 119 |
| install-arm64 / Install smoke (linux-arm64) | success | 30 | 4 | 0 | 33 | 1 | 43 | 8 | 89 |
| linux-perf / Performance (linux-x64 2) | success | 5 | 8 | 0 | 0 | 0 | 89 | 4 | 101 |
| linux-perf / Performance (linux-x64 idle) | success | 9 | 24 | 0 | 0 | 0 | 319 | 7 | 350 |
| linux-perf / Performance (linux-x64 1) | success | 15 | 13 | 0 | 0 | 0 | 105 | 5 | 123 |
| linux-perf / Performance (linux-x64 3) | success | 9 | 15 | 0 | 0 | 0 | 104 | 4 | 123 |
| linux-package-x64 / Package (linux-x64) | success | 2 | 31 | 115 | 0 | 13 | 0 | 10 | 169 |
| install-x64 / Lint scripts and dry-run the npm package | success | 24 | 4 | 0 | 1 | 2 | 0 | 3 | 10 |
| install-x64 / Install smoke (linux-x64) | success | 3 | 5 | 0 | 23 | 1 | 57 | 3 | 89 |
| linux-package-arm64 / Install smoke (ubuntu:24.04, linux-arm64 deb) | success | 4 | 8 | 0 | 0 | 0 | 0 | 40 | 48 |
| linux-package-x64 / Install smoke (ubuntu:24.04, linux-x64 deb) | success | 3 | 10 | 0 | 0 | 0 | 0 | 30 | 40 |
| linux-package-x64 / Install smoke (archlinux:base-20260927.0.600689@sha256:eb8f6dcc89a38977c9735f10fcf6ae4afe496283e7008eb7a3420cdba31fbd04, linux-x64 pacman) | success | 3 | 9 | 0 | 0 | 0 | 0 | 31 | 40 |
| linux-package-x64 / Install smoke (debian:trixie, linux-x64 deb) | success | 3 | 9 | 0 | 0 | 0 | 0 | 30 | 39 |
| macos-tests / workspace | success | 540 | 17 | 31 | 0 | 0 | 0 | 5 | 53 |
| macos-tests / E2E (darwin-arm64 6) | success | 58 | 15 | 0 | 0 | 0 | 189 | 6 | 210 |
| macos-tests / E2E (darwin-arm64 ins-14) | success | 7 | 34 | 0 | 0 | 0 | 6 | 5 | 45 |
| macos-tests / E2E (darwin-arm64 2) | success | 6 | 13 | 0 | 0 | 0 | 216 | 9 | 238 |
| macos-tests / E2E (darwin-arm64 5) | success | 278 | 34 | 0 | 0 | 0 | 219 | 9 | 262 |
| macos-tests / E2E (darwin-arm64 1) | success | 741 | 36 | 0 | 0 | 0 | 232 | 8 | 276 |
| macos-tests / E2E (darwin-arm64 4) | success | 254 | 30 | 0 | 0 | 0 | 244 | 7 | 281 |
| macos-tests / E2E (darwin-arm64 3) | success | 549 | 36 | 0 | 0 | 0 | 216 | 7 | 259 |
| macos-tests / E2E (darwin-arm64 install) | success | 741 | 37 | 0 | 0 | 0 | 151 | 9 | 197 |
| macos-tests / E2E (darwin-arm64 ins-02) | success | 599 | 11 | 0 | 0 | 0 | 117 | 5 | 133 |
| macos-perf / Performance (darwin-arm64 idle) | success | 85 | 24 | 0 | 0 | 0 | 375 | 5 | 404 |
| macos-perf / Performance (darwin-arm64 2) | success | 214 | 18 | 0 | 0 | 0 | 121 | 8 | 147 |
| macos-perf / Performance (darwin-arm64 1) | success | 368 | 12 | 0 | 0 | 0 | 128 | 7 | 147 |
| macos-perf / Performance (darwin-arm64 3) | success | 292 | 19 | 0 | 0 | 0 | 123 | 5 | 147 |
| macos-package / Package and smoke unsigned darwin-arm64 App | success | 446 | 29 | 121 | 533 | 0 | 0 | 18 | 701 |
| install-macos / Lint scripts and dry-run the npm package | success | 5 | 6 | 0 | 2 | 4 | 0 | 3 | 15 |
| install-macos / Install smoke (darwin-arm64) | success | 476 | 7 | 0 | 72 | 1 | 66 | 24 | 170 |
| install-merge / Merge per-platform manifests | success | 2 | 9 | 0 | 0 | 0 | 0 | 2 | 11 |
| gate | success | 4 | 4 | 0 | 0 | 0 | 0 | 4 | 8 |
| Platform contracts and debug stub chat | success | 3 | 11 | 26 | 155 | 14 | 0 | 7 | 213 |
| Build unsigned Windows preview | success | 219 | 11 | 0 | 0 | 9 | 163 | 8 | 191 |
| Hosted Windows E2E (data) | success | 3 | 14 | 1 | 0 | 0 | 0 | 52 | 67 |
| Hosted Windows E2E (remote) | success | 3 | 13 | 3 | 0 | 0 | 0 | 182 | 198 |
| Hosted Windows E2E (recovery) | success | 3 | 12 | 0 | 0 | 0 | 0 | 122 | 134 |
| Installed unsigned Windows preview | success | 47 | 233 | 1 | 29 | 1 | 0 | 162 | 426 |
| Complete Windows preview verification | success | 3 | 1 | 0 | 2 | 0 | 0 | 3 | 6 |
| platform-paths | success | 2 | 3 | 0 | 1 | 0 | 0 | 2 | 6 |
| Windows compile check (x86_64-pc-windows-msvc) | success | 2 | 38 | 0 | 373 | 0 | 0 | 38 | 449 |
