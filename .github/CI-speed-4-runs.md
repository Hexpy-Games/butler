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

## Next measurement

The subsequent code push checks the corrected selector, verified embedded versions, original build configurations and artifact cache fallback. Its complete workflow wall times and results will be added to the draft PR. No release tag or post-release dispatch is authorized by this task, so release-after numbers remain estimates, not observations.
