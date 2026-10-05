# Butler Rust CI build-speed research

Research date: **2026-10-06**. Repository baseline: `c54d1b76140c2173220bbab271f9ea54cfe16cba`, branch `codex/rust-build-research`. This report changes no workflows, compiler pins, profiles, product code, tests, or release artifacts. No workflow was dispatched and no PR was opened.

The best near-term opportunities are **avoiding redundant cache transfers, improving cold release/cache coverage, and reducing recompilation caused by build provenance**. A newer stable compiler is worth evaluating, but the measured small workspace slice improved only 4.4%. Butler already uses most familiar recommendations: mold on Linux, sccache, nextest archives, incremental compilation disabled in hosted CI, and limited debug information. Queue delays also dominate some apparent 85-minute runs.

## 1. Where time goes today

### Method and sample boundaries

Read the current workflows and their composite actions, `ci-changes.py`, `cargo-artifact-cache.py`, `cargo-source-times.py`, the workspace manifest, and the Agent build script. Collected recent runs with:

```sh
gh run list --repo Hexpy-Games/butler --workflow rust-quality.yml --limit 25 \
  --json databaseId,headBranch,headSha,conclusion,createdAt,updatedAt,url
gh run view 37333375357 --repo Hexpy-Games/butler \
  --json jobs,createdAt,updatedAt,headSha,conclusion
gh api --paginate repos/Hexpy-Games/butler/actions/runs/37333375357/jobs
gh run view 37333375357 --repo Hexpy-Games/butler --log
gh api repos/Hexpy-Games/butler/actions/jobs/111864637693/logs
```

`gh run view --log` returned an empty stream on this host; the individual job-log API returned the logs. `gh run view --json jobs` omitted step timestamps, so the REST jobs API supplied them. Durations below are `completed_at - started_at`, rounded to whole seconds. Cargo's own reported time is identified separately. These are observations of existing runs, not controlled before/after experiments. Both quality runs failed downstream tests; their successful build jobs are still useful timing evidence. No tests were rerun or failures attributed to an unproven cause.

| Existing run | Result | Created → updated (UTC, October 5) | Wall time |
| --- | --- | --- | ---: |
| [Rust quality, main, 37333375357](https://github.com/Hexpy-Games/butler/actions/runs/37333375357) | Failure | 15:30:26 → 16:52:26 | 82m00s |
| [Rust quality, ci-affected PR, 37316697451](https://github.com/Hexpy-Games/butler/actions/runs/37316697451) | Failure | 13:25:37 → 14:50:33 | 84m56s |
| [Release, 37311352978](https://github.com/Hexpy-Games/butler/actions/runs/37311352978) | Success | 12:42:05 → 13:23:03 | 40m58s |
| [Windows preview, 37333174260](https://github.com/Hexpy-Games/butler/actions/runs/37333174260) | Success | 15:28:57 → 15:50:12 | 21m15s |
| [Post-merge CI, 37333374506](https://github.com/Hexpy-Games/butler/actions/runs/37333374506) | Success | 15:30:26 → 15:33:33 | 3m07s |

The 84m56s example includes workflow/packaging changes; it is **not a controlled Rust-only sample**. The current selector nevertheless makes a Rust change select `rust`, `package`, `install`, and `linux-package`, so packaging is part of the intended Rust-change path. Docs outside runtime resources select none of these groups.

### Critical path versus accumulated job minutes

In the 82-minute main run, `changes / paths` did not start until **16:20:24**, 49m58s after creation. Most builders started at 16:20:36–44. macOS archives finished at 16:32:51; the macOS idle performance job ran 16:33:02–16:46:03; the gate started at 16:52:09. These gaps are observed queue/scheduling/concurrency delay, **not rustc time**. The APIs do not establish which capacity or concurrency limit caused them.

In the 84m56s run, macOS archives ran 13:40:29–13:53:00, but macOS E2E shard 1 did not start until **14:42:27** and finished at 14:49:45: a 49m27s archive-to-shard-start gap. Compiler improvements cannot recover that entire interval. Do not sum concurrent job durations and call the sum wall-clock savings.

### Slow build and test steps

Main run 37333375357, with job links providing the detailed timestamps:

| Job | Total | Setup | Compile/check step | Other significant work |
| --- | ---: | ---: | ---: | --- |
| [macOS debug archives](https://github.com/Hexpy-Games/butler/actions/runs/37333375357/job/111864637693) | 727s | 372s | Clippy 62s; workspace build/archive 137s | Inventory 18s; doctests 17s; test upload 18s; Cargo snapshot creation 40s + upload 40s |
| [macOS production Agent](https://github.com/Hexpy-Games/butler/actions/runs/37333375357/job/111864637829) | 524s | 129s | 305s | Cargo snapshot creation 16s + upload 10s; post-cache work 36s |
| [Linux x64 Clippy](https://github.com/Hexpy-Games/butler/actions/runs/37333375357/job/111864636990) | 507s | 27s | Production 281s; all-targets 169s | Post-cache work 23s |
| [Linux x64 production Agent](https://github.com/Hexpy-Games/butler/actions/runs/37333375357/job/111864637243) | 317s | 77s | 173s | Snapshot 7s + upload 9s; post-cache work 36s |
| [Linux x64 debug archives](https://github.com/Hexpy-Games/butler/actions/runs/37333375357/job/111864637255) | 261s | 111s | 53s | Snapshot 19s + upload 12s; test upload 17s; post-cache work 22s |
| [Linux arm64 debug archives](https://github.com/Hexpy-Games/butler/actions/runs/37333375357/job/111864637663) | 331s | 141s | Clippy 31s; build/archive 52s | Snapshot 23s + upload 15s; post-cache work 25s |
| Linux arm64 production Agent | 275s | 44s | 192s | Same producer structure |
| Optimized E2E harness, Linux x64 / arm64 / macOS | 68 / 77 / 117s | 31 / 36 / 32s | 10 / 11 / 22s | Already warm; not a major compile bottleneck |
| [Windows hosted compile check](https://github.com/Hexpy-Games/butler/actions/runs/37333375357/job/111865157172) | 489s | 23s | 415s | No linking; post-cache work 36s |
| [macOS idle performance](https://github.com/Hexpy-Games/butler/actions/runs/37333375357/job/111869994099) | 781s | Artifact downloads 50s | No product compilation | Stub action 712s; failed |

The slowest ordinary macOS E2E shard was 460s; Linux x64's was 446s. Linux idle performance occupied 679s. Those execute prebuilt artifacts. Nextest cannot eliminate the underlying test work, and budgets/test contents must remain unchanged.

The earlier 84m56s run corroborates the pattern: macOS archive setup 279s, build/archive 112s, snapshot creation 38s, snapshot upload 133s, post-cache 81s; Linux archive setup 375s versus build/archive 46s. Its two real macOS update fixtures took **577s** to build, and the separate packaging job lasted 229s (including a failed UI comparison). Do not classify all packaging time as Rust compilation.

### Cache, native dependencies, and linking evidence

* **Double restore is real.** The main macOS archive job restored a full-match rust-cache entry of **2,429,973,230 bytes (~2317 MiB)**. The rust-cache action ran approximately 16:21:14–16:22:42 (88s). It then unconditionally ran `cargo-artifact-cache.py restore` until 16:27:06 (**263s**), restoring another complete target snapshot from run 37333174850. The fallback is named as an eviction recovery mechanism, but its condition only checks that a platform was supplied, not whether rust-cache hit. Both paths need source freshness validation. rust-cache also cleans some outputs, so a full key hit is not proof that it contains every executable in the artifact snapshot. Prefer a verified complete artifact first, then restore only missing registry/native inputs; skipping the second restore without equivalent completeness and freshness could force recompilation.
* **Clippy's configured sccache was cold in this sample:** zero hits, 955 misses (707 Rust, 229 C/C++, 19 assembler), 197 non-cacheable calls. macOS archive had only one miss and 16 non-cacheable calls: Cargo itself reused most outputs before sccache was needed. Thus a zero sccache hit rate alone does not mean the target cache failed. The reasons for the Linux misses were not established; investigate key/branch scope, eviction and compiler/flag changes before selecting a fix.
* **Native ORT was restored, not rebuilt, in the inspected warm macOS native job.** A static-ORT cache miss at 16:21:11 recovered an artifact by 16:21:54; prepare/verification finished around 16:21:56. Re-saving the runtime cache took about 23s; recording and uploading its artifact took another ~17s. The recipe's fingerprint checks must remain intact. Protoc/prebuilt setup is not the main warm build cost.
* **Warm native jobs still rebuild the Agent.** macOS native restored Cargo outputs at 16:23:03, then Cargo reported **5m03s**, with `butler-agent` the only workspace crate logged as compiling. The debug archive similarly reported **2m07s**, followed by a **2.17s** nextest build. `crates/butler-agent/build.rs` tracks Git HEAD/index and emits revision/version environment values into the Agent crate. That creates a plausible large invalidation boundary even when most sources are unchanged. The logs establish recompilation, not a separate timing for provenance-related work.
* **Compile versus link is not instrumented in these CI logs.** Cargo's totals include frontend, LLVM, native build scripts, and linking. No defensible standalone link-time number can be extracted from a `Finished` line. Add stable `--timings` and an opt-in linker timing wrapper or nightly section timings before claiming that a 303s warm Agent rebuild is mostly linking.

### Releases and Windows

The successful [Linux x64 release job](https://github.com/Hexpy-Games/butler/actions/runs/37311352978/job/111767275500) lasted **2072s**. Its large composite step took 2025s; Cargo alone reported **31m05s** (12:44:40–13:15:45). The static ORT artifact was successfully recovered in ~44s, but the Cargo fallback said **no compatible snapshot**. This was a cold optimized Rust graph, not 31 minutes of ORT compilation. LanceDB/Arrow and the memory stack were among the compiled dependencies. Linux arm64 release took 1621s overall; that composite step was 1589s, without a separately extracted Cargo duration.

The [macOS release job](https://github.com/Hexpy-Games/butler/actions/runs/37311352978/job/111767275776) lasted 916s: native setup/cache 166s, native build 374s, App packaging 118s. The [self-hosted Windows release producer](https://github.com/Hexpy-Games/butler/actions/runs/37311352978/job/111767275993) reported **11m40s** for the release binary. The [later Windows preview producer](https://github.com/Hexpy-Games/butler/actions/runs/37333174260/job/111841298385) reported **1m38s** for `ci-fast`. These different commits/cache states/profiles are **not an A/B comparison**. Windows release explicitly uses ThinLTO, one codegen unit and static CRT; those settings must remain.

`post-merge-ci.yml` currently adds a hosted Windows workspace check (99s in its latest 155s job). Rust quality also ran a hosted Windows check on the same main revision (415s). These are separate cache namespaces/jobs; sharing validated inputs could reduce duplicate work without removing either required check. Windows preview additionally uses the persistent owner runner for its builds and platform tests. The installed-preview and hosted E2E jobs run tests rather than rebuild the full Rust graph.

### What duplication can actually be removed?

`rust-archive.yml` already builds the entire debug workspace once, inventories every selection, and distributes nextest archives; shards do not each compile the Agent. `rust-perf-archive.yml` builds the optimized black-box E2E harness; that crate depends on the platform boundary and harness dependencies, **not** the Agent/Lance product graph. Native producers independently compile an optimized Agent. Debug versus release, static versus prebuilt ORT, Clippy metadata versus codegen, and different targets are legitimate distinct Cargo units.

Some dependencies recur across those graphs (Tokio, Serde, SQLite, platform), but unifying cache keys cannot make incompatible units reusable. Actual avoidable work is redundant cache transfer, cold compatible dependencies, repeated builds with identical unit inputs, and potentially broad Agent invalidation. `release-macos.yml` and `build-agent-archive` already attempt compatible cache/artifact reuse; extend those mechanisms rather than proposing them as new.

## 2. What is new, and ranked candidates

### Stable/nightly status as of October 6, 2026

The latest verified stable release is **[Rust 1.99.0, October 1](https://blog.rust-lang.org/2026/10/01/Rust-1.99.0/)**. The repository pins 1.91.0. The host initially had 1.91.0 and a `stable` alias still pointing to 1.98.1; 1.99.0 was installed separately for measurement. A floating local `stable` alias is not evidence of the latest release.

| Development | Verified status and significance |
| --- | --- |
| rustc/Cargo 1.99 | Cargo now disables incremental by default when `CI` is set and adds a `debug` profile currently equivalent to `dev`. Neither changes Butler's existing explicit profile/cache behavior materially. The advertised 20–40% rustdoc improvement is documentation generation, not a general `cargo build` improvement. [Versioned release notes](https://github.com/rust-lang/rust/blob/1.99.0/RELEASES.md#version-1990-2026-10-01), [CI incremental PR](https://github.com/rust-lang/cargo/pull/17220). |
| Recent compiler changes | [1.97](https://blog.rust-lang.org/2026/07/09/Rust-1.97.0/) made v0 symbol mangling the default. [1.98.1](https://blog.rust-lang.org/2026/09/03/Rust-1.98.1/) fixed a 1.98.0 vtable miscompilation: avoid benchmarking/adopting the unpatched 1.98.0. Release notes do not establish an across-the-board Butler speedup. |
| Default LLD | **Stable since 1.90 for `x86_64-unknown-linux-gnu`**, not a universal Linux/macOS/Windows default. Rust's ripgrep example saw 7× faster linking, 40% faster incremental rebuilds and 20% faster cold debug builds versus the former linker. These are not gains over Butler's existing mold. [Rust announcement](https://blog.rust-lang.org/2025/09/01/rust-lld-on-1.90.0-stable/). |
| Parallel frontend | Still an opt-in **nightly** experiment with `-Zthreads=N`; [tracking issue #113349](https://github.com/rust-lang/rust/issues/113349) remains open. The original [Rust measurements](https://blog.rust-lang.org/2023/11/09/parallel-rustc/) report up to 50% compilation improvement and up to 35% more memory, not a guarantee. Cargo crate parallelism and LLVM codegen parallelism already exist. The 2026 [project update](https://blog.rust-lang.org/2026/05/18/project-goals-2026-04/#promoting-parallel-front-end) records continuing work. |
| Cranelift | **Nightly preview**, installed with `rustup component add rustc-codegen-cranelift-preview --toolchain nightly`, selected via `CARGO_PROFILE_DEV_CODEGEN_BACKEND=cranelift cargo +nightly build -Zcodegen-backend`. Upstream lists Linux/macOS and x64 Windows support, but incomplete architecture intrinsics and experimental panic unwinding, unsupported on Windows/macOS. This is material to Butler's native/SIMD dependencies and test semantics. Not an LLVM-quality release replacement. [Official backend README](https://github.com/rust-lang/rustc_codegen_cranelift). |
| mold / Wild | External linkers usable with stable rustc; neither is rustc's default. Butler already installs mold on Linux. [mold](https://github.com/rui314/mold) is an ELF linker, not a macOS/Windows drop-in. [Wild](https://github.com/wild-linker/wild) targets Linux, explicitly lists Mach-O/Windows as unsupported, and still describes incremental linking as future work. Do not sell Wild as an already incremental linker. |
| Cargo build directory | `build.build-dir` / `CARGO_BUILD_BUILD_DIR` is **stable since 1.91**, separating intermediates from final `target` outputs. This is not an automatic global shared artifact cache. The new layout is nightly in the 1.99 era; current development notes list its restabilization for **1.100 (November 12, future at this cutoff)**. [1.91 changelog](https://doc.rust-lang.org/nightly/cargo/CHANGELOG.html#cargo-191-2025-10-30), [configuration](https://doc.rust-lang.org/cargo/reference/config.html#buildbuild-dir), [layout PR](https://github.com/rust-lang/cargo/pull/17354). |
| Incremental and cache freshness | Incremental is stable and useful for persistent edit/build loops, but conflicts with sccache's Rust caching. `-Zchecksum-freshness` remains nightly; it can avoid mtime-only invalidation on restored checkouts. Cargo 1.88's stable global-cache GC cleans downloaded source/cache data, not a shared compiled target cache. [Unstable features](https://doc.rust-lang.org/cargo/reference/unstable.html#checksum-freshness), [sccache restrictions](https://github.com/mozilla/sccache/blob/main/docs/Rust.md), [GC status](https://doc.rust-lang.org/cargo/reference/unstable.html#automatic-garbage-collection). |
| Smaller intermediate metadata | Nightly `-Zembed-metadata=no` avoids duplicating crate metadata in rlibs when separate rmeta is available; an August 2026 experiment, not a stable build-speed switch. Potential transfer/disk benefit needs Butler measurement. [Rust experiment](https://blog.rust-lang.org/inside-rust/2026/08/18/reducing-target-dir-size-on-nightly/). |
| `-Zshare-generics` | The explicit switch remains **nightly**. In rustc 1.99, default sharing is already enabled at opt-level 0, 1, s and z, disabled at 2 and 3. Enabling it for ordinary debug code is not a new saving. Sharing optimized generics changes optimization tradeoffs: keep release unchanged. [Versioned implementation](https://github.com/rust-lang/rust/blob/1.99.0/compiler/rustc_session/src/config.rs#L1521), [unstable option](https://github.com/rust-lang/rust/blob/1.99.0/compiler/rustc_session/src/options.rs#L2842). |
| Split debuginfo and profiles | Existing stable Cargo controls. Butler already uses line tables, no dependency debuginfo, and packed splitting. macOS unpacked avoids dSYM packing but retains objects; the repo specifically documents historical >50 GB targets. Windows uses PDB, so a Linux DWARF recipe is not portable. Also `lto=false` can still mean **local ThinLTO**, unlike `lto="off"`; the `ci-fast` comment is shorthand, not the precise Cargo semantics. [Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html), [rustc split debuginfo](https://doc.rust-lang.org/rustc/codegen-options/index.html#split-debuginfo). |
| nextest / sccache | External tools usable with stable Rust. [Nextest archive/reuse](https://github.com/nextest-rs/nextest/blob/main/site/src/docs/ci-features/archiving.md) separates build and test machines; Butler already does this. sccache is complementary to Cargo outputs, does not cache final linking, and needs incremental off. [rust-cache](https://github.com/Swatinem/rust-cache) already disables incremental; Butler also receives that setting from toolchain setup. No new savings from merely adding these tools. |

The moving nightly documentation includes future-release sections. This report does not classify November/December changes as released on October 6. None of the nightly options was enabled for a release or test run here.

### Ranking by likely savings relative to effort and risk

Savings are **hypotheses/ceilings unless explicitly measured**. They are not additive, especially across concurrent jobs. Effort is a rough engineering estimate, excluding the time needed to observe several representative CI runs. Platform abbreviations: L = Linux, M = macOS, W = Windows.

| Rank | Candidate and mechanism | Expected saving / evidence | Status; platforms | Effort, risk and release constraints |
| --- | --- | --- | --- | --- |
| 1 | Select one complete Cargo restore path; carry validated source timestamps/identities with it. Separate registry/ORT caches from redundant target payloads. | Main macOS job spent ~88s restoring rust-cache and then 263s restoring the full artifact. Avoiding one could save **roughly 1–4 minutes** when freshness/rebuild cost stays equal. This is a target, not a measured net gain. Also preserve compatible static-mode snapshots to prevent the observed 31m05s cold Linux release build. | Stable infrastructure; L/M/W, greatest observed transfer cost M. | ~1–3 days, low/medium risk. Must retain compiler/flags/target/ORT/source identity, archive digest and path validation. Never restore an incompatible release payload. Local Cargo-fresh probe below demonstrates the ceiling of output reuse, not network savings. |
| 2 | Improve compatible-cache coverage and remove avoidable Agent invalidation. Audit provenance environment transitions; consider a small provenance crate consumed by the heavy Agent library. | Warm macOS native spent **303s** recompiling the Agent; debug build 127s. These are upper bounds on removable work, not predictions. A leaf may leave linking/LTO dominant. Clippy also spent 450s checking a cold graph. | Stable; L/M/W. | Cache diagnostics ~1 day; provenance refactor ~3–5 days, medium correctness risk. Preserve exact embedded version, current commit, dirty-state rules and memory qualification. Never fake old provenance for a cache hit. Measure an unchanged build, a provenance-only change, and a real source change before adoption. |
| 3 | Evaluate a pinned 1.99.0 toolchain across the graph; take accumulated rustc/LLVM/Cargo improvements. | Local 198-unit `butler-core` test build **25.345 → 24.225s (4.4%)**, one sample. Whole Agent/Lance savings unmeasured; do not extrapolate to 85 minutes. | Stable; L/M/W. | ~1–2 days plus platform CI; medium risk: new Clippy lints, edition-2024 dependency feature behavior, native toolchain/cache invalidation. Preserve full release optimization and test every artifact. |
| 4 | Move build producers onto available, isolated persistent capacity; keep test artifacts and all shards. Use keyed per-target/per-profile output directories. | The sampled queue gaps were ~50 minutes. Eliminating such waits has a much larger potential wall-time effect than the measured compiler change, but capacity feasibility is unmeasured. Stable `build-dir` can keep intermediates outside disposable checkouts; no automatic cross-workspace cache guarantee. | Stable; L/M/W with corresponding native hosts. | Medium/high operational effort. Build/test isolation and cache trust matter; never run concurrent writes into one shared target. Do not place CI on the owner's live service paths. This is scheduling work, not a rustc optimization. |
| 5 | Keep mold; optionally use bundled default LLD on Linux x64 to remove mold installation. Experiment with Wild only in dev/test. | Local 1.98.1 mold vs default LLD **24.885 vs 25.079s**: effectively no useful evidence of a difference. Linux Clippy spent ~10s installing mold. Wild's Butler benefit unmeasured. | LLD/mold via stable; Wild external experimental; L only for the proposed ELF changes. | Low effort for LLD experiment, higher native-link risk for Wild. Validate static ORT symbols, runtime load, archives and debugging before any release linker change. No release change recommended now. |
| 6 | Tune dev/test split debuginfo or incremental mode for persistent builders, retaining complete test content and backtraces. | No measured remaining debug-info saving; reductions already applied. Persistent incremental could help Agent edits but costs storage, can hurt cold builds and disables sccache eligibility for those units. | Stable, target-specific; L/M/W. | ~1–2 days experimentation; low release risk if strictly dev/test. Keep optimized perf harness and existing SQLite/hash/compression overrides. Do not switch macOS to unpacked without measuring cache size and all debug artifacts. |
| 7 | Trial `-Zthreads=2/4/8` with fixed Cargo `-j8` on large frontend-bound crates. | Upstream reports up to 50% in some workloads; **no Butler measurement**. Potentially useful at the long final-crate tail; may use more RAM. | Nightly; L/M/W supported compiler hosts. | ~1–2 days experimental lane, medium/high risk. Keep memory bounded and test inventory identical. No release adoption or blanket 50% claim. |
| 8 | Trial checksum freshness / metadata deduplication / new build-dir layout. | Could replace fragile mtime restoration and reduce the multi-GB target transfer. No Butler byte/time A/B yet. | Nightly at cutoff; L/M/W. | Medium/high integration effort because Butler inspects and archives `target`. Validate freshness on source/resource/toolchain changes; cannot serve stale content. |
| 9 | Cranelift for compatible dev targets only. | Faster unoptimized codegen is the mechanism; no supported Butler-wide saving measured. Native/SIMD and unwinding gaps prevent assuming equivalent test coverage. | Nightly preview; L/M, x64 W, with backend restrictions. | High qualification cost. Reject if existing tests require unsupported semantics; no panic-strategy changes, skipped tests, perf/release use, or LLVM optimization reduction. |
| 10 | Explicit generics sharing / profile changes / further nextest rollout. | Sharing is already default for opt-level 0; nextest build-once already deployed; `ci-fast` already used for Windows previews. **Zero demonstrated new saving** from enabling these again. | Sharing override nightly; profiles/nextest stable; L/M/W. | Low priority. Do not remove Windows release ThinLTO/CGU=1 or substitute preview binaries for releases. |

Do not collapse the two Clippy invocations merely to get a shorter number: production and test feature contexts can differ. First preserve and prove equivalent coverage. Likewise, preserve the two real update-fixture versions and doctests; reuse compatible dependencies between them instead of removing their builds.

## 3. Local measurements

### Environment and controls

WSL Linux x86_64 on the i9-13900K; 32 logical CPUs visible, **47 GiB** guest RAM (host specification is 64 GB), ~35 GiB available at initial observation. Other host services were left alone. One Cargo command ran at a time with `-j8`. Each build/test/check got fresh `HOME` and `BUTLER_DATA`; Cargo/Rustup caches remained `/home/yeonw/.cargo` and `/home/yeonw/.rustup`. No live models, E2E services, protected ports or installed Butler data were used.

Measured `cargo test -p butler-core --lib --no-run`, which includes the real platform dependency, bundled SQLite, Tokio, ICU and proc macros: **198 Cargo artifact units**, not a synthetic Rust file. This deliberately excludes Lance/Arrow/ORT and the Agent binary to bound resource use. It cannot characterize the full product or release linker tail. Registry sources were already cached; `--offline --locked` excluded download/resolution noise. Each cold case used a distinct empty target subtree. Filesystem/page caches were not flushed.

`RUSTC_WRAPPER=''` disabled sccache for these comparisons; `CARGO_INCREMENTAL=0` matches CI. Existing manifest profile settings remained intact. Local mold was 2.40.4 and installed sccache was 0.18.0 (the latter unused in these A/B builds). Times are Python `time.monotonic()` around the Cargo subprocess, not the subsequent tests. **One sample per condition**, fixed order, shared host: small differences are exploratory, not statistical proof.

| Condition, in execution order | Wall seconds | Fresh units / total | Result |
| --- | ---: | ---: | --- |
| Rust 1.91.0, cold, mold | 25.345 | 0 / 198 | Built complete selected harness |
| Same 1.91 target, unchanged inputs | 0.137 | 198 / 198 | Reused complete selected harness |
| Installed `stable` = 1.98.1, cold, mold | 24.885 | 0 / 198 | Built complete selected harness |
| Installed `stable` = 1.98.1, cold, default LLD | 25.079 | 0 / 198 | Built complete selected harness |
| Rust 1.99.0, cold, mold | 24.225 | 0 / 198 | Built complete selected harness |

Unchanged output reuse avoided **25.208s (99.5%)** in this small case, with no restore cost. This is a best-case no-op, **not** the expected speedup after changing code or downloading a snapshot. 1.99 saved **1.120s (4.4%)** relative to 1.91; 1.98.1 saved 0.460s (1.8%). Default LLD was 0.194s slower than mold in the 1.98.1 cold comparison; that magnitude warrants no linker recommendation.

All five build outputs enumerated the **same ordered inventory of seven tests**. The four independently built test executables each ran all seven with `--test-threads=8`: **28 passed, 0 failed, 0 ignored, 0 filtered out**. The unchanged-build executable was the same existing artifact, so it did not need a duplicate test run. Cargo JSON confirmed the full 198-unit inventory, including 198 fresh units on the no-op case. No output/test content was dropped to achieve the numbers.

### Reproduction commands

From the worktree root, save caches before changing HOME. The actual harness created a new home/data directory per invocation using Python `tempfile.mkdtemp`, selected the rows below, redirected Cargo JSON and stderr to `/tmp`, and measured the subprocess with `time.monotonic()`. Equivalent shell commands are:

```sh
export CARGO_HOME=/home/yeonw/.cargo RUSTUP_HOME=/home/yeonw/.rustup
research_root="$PWD"
cd packages/butler-agent/rust

# Run separately for each row, allocating fresh HOME/BUTLER_DATA each time.
export HOME=$(mktemp -d) BUTLER_DATA=$(mktemp -d)
export CARGO_BUILD_JOBS=8 CARGO_INCREMENTAL=0 RUSTC_WRAPPER=''
export CARGO_TARGET_DIR="$research_root/target/baseline"
export RUSTFLAGS='-C link-arg=-fuse-ld=mold'
cargo +1.91.0 test --locked --offline -j 8 -p butler-core --lib --no-run \
  --timings --message-format=json-render-diagnostics
```

Repeat that exact Cargo command once on `target/baseline` for the unchanged-input case, with fresh home/data. For the subsequent cold rows use `(toolchain, target, RUSTFLAGS)`:

```text
stable (then 1.98.1), target/new,    -C link-arg=-fuse-ld=mold
stable (then 1.98.1), target/lld,    empty string
1.99.0,              target/latest, -C link-arg=-fuse-ld=mold
```

For future reproduction pin `+1.98.1` instead of the mutable `+stable` alias. Find the test executable using the JSON `compiler-artifact` message with `profile.test=true` and a non-null `executable`; run `EXE --list` and `EXE --test-threads=8`, again with fresh home/data and the Rust workspace as working directory. All timing/build logs were kept outside tracked files; generated targets are removed at task completion.

### Not measured

The highest-ranked **net remote cache restore improvement** and **provenance refactor** were not implemented, so they have no before/after CI result. No full Agent/Lance cold build, release build A/B, macOS/Windows local build, sccache cold/warm A/B, link-only profile, parallel frontend, Cranelift, Wild, or split-debug variant was measured. CI numbers establish where to investigate, not the counterfactual runtime after changes. Full E2E/performance qualification belongs to the adoption experiment; no release runs or additional CI jobs were triggered for this report.

## 4. Concrete adoption plan

These are proposed changes for subsequent authorized work, not changes made on this branch. Keep all selected tests, current timeouts, performance budgets, release optimization, resources, native dependencies and provenance intact.

1. **Instrument one representative Rust-only PR and one release-equivalent build without publishing.** Change `.github/workflows/{rust-archive,rust-perf-archive,native-agent}.yml`, `.github/actions/build-agent-archive/action.yml`, `.github/workflows/release-macos.yml`, and `.github/actions/build-windows-agent/action.yml` to preserve `--timings`, exact compiler/profile/target/feature identity, cache transfer bytes/times and sccache stats. Record queue time separately. Add optional linker timing only to the experiment. Compare complete nextest inventories, test results, latest state and artifact contents in every timed case. Do not dispatch an actual release just to measure.

2. **Make complete target restoration mutually exclusive and freshness-safe.** In `.github/actions/rust-agent-setup/action.yml` and `.github/scripts/{cargo-artifact-cache,cargo-source-times}.py`, return an explicit verified-snapshot outcome, choose a single complete target source, and retrieve its matching source identity/timestamps. Keep registry/native inputs separately available. Preserve current trust, digest, compiler/flags/ORT/target validation. Include existing cache security/freshness tests found under `.github/scripts/test-*.py`; prove that changed Rust, resources, manifests, version and commit inputs rebuild. Compare total restore + rebuild + save time, not transfer alone. Target the observed duplicate 88s/263s paths first. Extend compatible **static-ORT** cache coverage for cold Linux releases; prebuilt-ORT outputs must never masquerade as static artifacts.

3. **Trial a single pinned stable upgrade.** Update `packages/butler-agent/rust/rust-toolchain.toml`, `.github/actions/rust-agent-setup/action.yml`, the explicit source-job pin in `.github/workflows/rust-quality.yml`, and the toolchain pins/setup under `.github/actions/windows-owner-setup`. Audit all `1.91` occurrences before editing; retain the declared MSRV unless deliberately changing it. Start with 1.99.0, handle new lints without weakening checks, and measure the full graph with the same cache state. Qualify Linux x64/arm64, macOS arm64 and Windows MSVC; verify static ORT and release manifests, signing/notices/resources, correctness and existing performance limits.

4. **Narrow provenance-driven recompilation if timing confirms it is worthwhile.** Inspect `packages/butler-agent/rust/crates/butler-agent/build.rs` and the consumers of `BUTLER_RELEASE_VERSION`, `BUTLER_BUILD_ID`, and verified commit values. Move only the small changing metadata boundary into a suitable leaf/build unit or pass it at the executable boundary; keep the heavyweight library independent where possible. Normalize version environment inputs across archive Clippy/build/doctest steps in `rust-archive.yml`. Prove two different commits/versions produce their correct, distinct diagnostics/qualification values, including dirty-source refusal. Measure both real source edits and provenance-only edits with full LLVM optimization. Retain the current design if linking/LTO erases the benefit.

5. **Reduce scheduling delay and duplicate compatible work without reducing coverage.** Audit `.github/workflows/{rust-quality,post-merge-ci,rust-tests,windows-preview-smoke}.yml` and `.github/scripts/{ci-changes,test-ci-changes,test-ci-invariants}.py`. Preserve all selected tests and receipt identities. Investigate the observed ~50-minute gaps before provisioning runners; use native isolated producers with persistent keyed output caches if justified. Share exact compatible Windows check inputs, retain nextest archive inventory/partition checks, and cap local build/test concurrency at eight. Review build-dir adoption against scripts that assume `target`; do not turn it on blindly.

6. **Only then run a separate nightly/dev experiment.** Use an opt-in experimental workflow/config for parallel frontend, checksum freshness/metadata deduplication, then compatible Cranelift or Wild targets. Keep a stable LLVM control, identical test inventories and full results; reject regressions or unsupported tests rather than excluding them. Keep production release jobs on the validated stable toolchain/profile. Never reduce release LTO, codegen quality, panic semantics or artifact contents to claim a win.

## 5. Validation of this research change

Only this Markdown report is committed. Validation completed with fresh home/data directories for every check:

* Five timed Cargo builds: passed; 198 artifact units each, including 198 fresh units in the unchanged-input case.
* Four complete selected `butler-core` library test runs: 28/28 passed, identical seven-test inventories, no ignored or filtered tests.
* `cargo fmt --all`: passed, no Rust source changes.
* `cargo clippy --locked --offline -j 8 -p butler-source-check --all-targets -- -D warnings`: passed (1.54s Cargo-reported).
* `cargo run --locked --offline -j 8 -p butler-source-check -- .`: passed; 2,385 files scanned, zero violations in reported gates (2.21s build time).
* `git diff --cached --check`: passed.
* `git fetch origin`: current `origin/main` remained the baseline commit; no merge was needed.

No TS/UI changed, so Bun/UI checks are not applicable. No product crate was edited; whole-workspace Clippy/E2E are not substitutes for later adoption qualification. The requested `docs/` path is ignored by the repository, so this report alone is force-added without changing ignore rules. Generated worktree targets are deleted after validation. No PR exists for `gh pr checks`; branch Actions are inspected after push instead.

The unmeasured items in section 3 remain future research, not completed optimizations. No CI speedup is claimed to have been deployed.
