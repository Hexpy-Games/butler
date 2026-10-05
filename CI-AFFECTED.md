# PR checks by changed inputs

Every PR workflow starts with `changes`. It compares the complete checkout with
`pull_request.base.sha`, using a NUL-delimited Git diff with rename detection
disabled so both sides of a rename select their owners. Merge groups use their
base SHA. Main, merge groups, schedules and manual checks retain full coverage. No workflow-level PR
path filter can leave a required check missing on documentation changes.

| Inputs | Responsible checks |
| --- | --- |
| Agent Rust/resources, Cargo files, Rust/nextest configuration, VERSION | Format/source, clippy, workspace/E2E archives and shards, perf; native packaging/install/update checks because the agent is bundled |
| App client, i18n, other Bun packages/tools/tests, Bun/TS configuration and lock | Bun unit suite, Windows source/build checks, DS browser smokes; shared UI/i18n assets also select existing site checks |
| Electron/main process, deploy, release/Windows packaging scripts, native installer inputs | Native package/install/update smokes on the existing platforms; updater UI integration paths keep their existing native smokes |
| Site source | Site check/build/leak/font checks |
| Dependency inventories, locked catalog inputs and license notices | Existing deterministic license/disclosure checks |
| `.github/**` | Every category |
| Documentation Markdown, plans, readme assets (runtime prompts/skills/fixtures and distribution notices retain their owners) | Repository/CI lint only |
| Unclassified executable/configuration input | All categories, conservatively |

Existing job names, reusable test workflows, assertions, matrix entries and
budgets remain. The existing `gate` and `Complete Windows preview verification`
aggregates reject failed/cancelled checks and unexpected skips. The other PR
workflows also have small aggregates with the same rule. Legitimately skipped
jobs still create successful skipped check runs. Branch-protection settings are
not changed.

## Reuse on subsequent PR commits

`git ls-tree -rz HEAD` hashes complete tracked input identities (path, blob, mode),
including workflow/action/script inputs in every category. Hashes are computed
from the checked-out merge tree, so relevant changes from main invalidate reuse.
Documentation and other categories do not invalidate unrelated checks. Packaging
selection owns native/electron/installer inputs; renderer-only changes are
validated by the UI build and smoke owners.

Gates publish `ci-inputs-<workflow>-<attempt>` artifacts containing only categories
whose full producer/consumer group succeeded. A failure in one category cannot
supply a success receipt for that category. The Windows receipt is published only
after its complete installed-harness assertion succeeds. An informational Windows
compile failure is never recorded as a passed input.

The next run checks up to the latest 100 runs of that same workflow and PR branch,
so other busy branches cannot evict its recent proofs from the search. A receipt
must belong to the same repository and PR, come from a completed noncancelled PR
run/attempt with a successful publication step, and match the current category
hash exactly. Expired/missing receipts, API errors and changed hashes run the
checks normally. No builds or tests are retried. Previously passed unchanged
categories are intentionally skipped, including when another category failed.
The step summary lists the PR base, path count, selected flags and source run IDs.

The cumulative PR/base diff remains the correctness fallback when no prior proof
exists; same-hash receipts are the stronger comparison against prior successful
inputs. Force pushes, reversions, deletions and file-mode changes use the same
content proof. Receipt artifacts last 30 days; eviction only costs extra work.

## Validation and measurement

Local regression checks: ten tests in `.github/scripts/test-ci-changes.py`,
including receipt ownership of every selected gate check across all 128 flag
combinations, and the existing
`Gate`/`ArtifactTrust` tests from `.github/scripts/test-ci-invariants.py`. All run
through `.github/scripts/isolated.py`, which disposes HOME/BUTLER_DATA while
retaining tool caches. Actionlint validates every workflow and local action.

Measured on draft [PR #528](https://github.com/Hexpy-Games/butler/pull/528),
2026-10-05. The initial implementation changed `.github/**` and correctly selected
all owners. Because unchanged checks failed, it could not produce a full green
baseline. For the two isolated probes, the same draft PR temporarily used
`codex/ci-affected-measure-base` at `5cf02017d0d55e4f62d71d0fbcfeb021ca3709ab`
as its base, containing the frozen CI implementation. This made the changed-path
examples genuine UI-only and Rust-only increments without merging the feature
into main. Afterwards the PR base was restored to main, the draft closed and the
temporary base branch deleted. Both harmless source-comment probes were removed.

| Probe | Work selected | Wall clock, including queue | Result |
| --- | --- | --- | --- |
| UI `b12d31d80a43d60c6d6648a4a207692a52536901` | Bun units, DS browser smokes, site checks; no Rust, E2E, perf or packaging | 18m 43s | All five active workflows passed |
| Rust `bf66f4a4511054f4de04a7cb24e030483576a349` | Rust checks/tests/E2E/perf plus native packaging/install/update checks; UI/DS/site reused, license work skipped | 84m 56s | Existing check failures kept the aggregates red |

Wall clock is earliest run creation to latest completion across the five active
PR workflows. The UI workload itself took 32s (site), 98s (DS) and 96s (Bun
units); Bun waited 14m 56s in the macOS runner queue. The Rust Windows preview
workflow took 23m 25s. Queueing contributed substantially to the Rust total too.

Evidence: UI [Rust-quality run](https://github.com/Hexpy-Games/butler/actions/runs/37314059576),
[Windows](https://github.com/Hexpy-Games/butler/actions/runs/37314059025),
[post-merge](https://github.com/Hexpy-Games/butler/actions/runs/37314059083),
[signing](https://github.com/Hexpy-Games/butler/actions/runs/37314059001),
[licenses](https://github.com/Hexpy-Games/butler/actions/runs/37314059075).
Rust [Rust-quality run](https://github.com/Hexpy-Games/butler/actions/runs/37316697451),
[Windows](https://github.com/Hexpy-Games/butler/actions/runs/37316696654),
[post-merge](https://github.com/Hexpy-Games/butler/actions/runs/37316696870),
[signing](https://github.com/Hexpy-Games/butler/actions/runs/37316696700),
[licenses](https://github.com/Hexpy-Games/butler/actions/runs/37316696850).

The downloaded Rust-quality receipt proves `ui`, `ds` and `site` reused exact
hashes from run `37314059576`. Its previous-run diff contains only
`packages/butler-agent/rust/tools/source-check/src/main.rs`, while the cumulative
base diff still contains the earlier UI comment. Thus these UI skips demonstrate
reuse, rather than only base-diff filtering. Failed Rust/macOS-package groups
have no passed receipt; successful Linux-package/install groups do. All existing
checks and failure gates remained in force. A one-off local live-API diagnostic
initially failed because the just-completed UI run was absent from its listing;
the actual Actions run found and verified the receipt. Missing history safely
causes extra checks rather than an unchecked skip.

### Check failures left unchanged

Open issues were searched before filing or commenting. These failures are not
claimed fixed, and their shared causes have not been inferred:

| Observation | Location | Tracking |
| --- | --- | --- |
| Linux queued crash-recovery case timed out: 60 passed, 1 failed | `packages/butler-agent/rust/crates/butler-e2e/tests/e2e/memory_rules/support.rs:97` | [#397](https://github.com/Hexpy-Games/butler/issues/397), distinct occurrence documented |
| macOS comparison fixture omits imported `WinFixesHarness` | `tests/smoke/quick-fixes-compare.ts:19` | [#533](https://github.com/Hexpy-Games/butler/issues/533), missing tracked fixture reproduced |
| macOS data-perf agent readiness failed; the idle-footprint test passed | `packages/butler-agent/rust/crates/butler-e2e/tests/e2e/data_perf.rs:32` | [#458](https://github.com/Hexpy-Games/butler/issues/458), readiness observation documented |
| Windows command budget: 13.0749263s against 5s | `packages/butler-agent/rust/crates/butler-e2e/tests/e2e/windows_commands/capabilities.rs:282` | [#504](https://github.com/Hexpy-Games/butler/issues/504), observation documented |
| Windows protoc setup: Schannel revocation check unavailable, compile never started | `packages/butler-agent/rust/scripts/prepare-static-ort.py:289` | [#534](https://github.com/Hexpy-Games/butler/issues/534) |
| Initial baseline Linux perf exceeded unchanged storage/artifact budgets | `packages/butler-agent/rust/crates/butler-e2e/tests/e2e/storage_concurrency.rs:359`, `packages/butler-agent/rust/crates/butler-e2e/tests/e2e/project_artifacts.rs:74` | [#506](https://github.com/Hexpy-Games/butler/issues/506), [#505](https://github.com/Hexpy-Games/butler/issues/505); all Linux perf shards passed in the Rust probe |
| Windows Desktop Source was already disabled in repository Actions settings | `.github/workflows/windows.yml:1` | Preserved and statically validated; not enabled or measured |

Local checks passed: 10 selector regressions, 4 existing gate/artifact-trust
tests, 16 existing source-check tests, cargo fmt, source-check clippy with
`-D warnings`, source rules (2,385 files; zero violations), actionlint 1.7.11
(`-shellcheck= -pyflakes=`; those optional integrations are not installed), frozen
Bun install with scripts disabled plus `bun run check`, signing policy self-test,
and `git diff --check`. Producer steps, matrices, budgets and Windows completion
harness assertions were compared against the original workflows and preserved.
Final refinements scope API history to the same branch and cover nested Cargo
files; their local regressions pass, while the timings above describe the frozen
measurement configuration. No test retries, timeout increases or live model
recordings were used. One final local Bun invocation lacked Bun in `PATH`, causing
20 child-process tests to fail (`spawnSync("bun")` returned `ENOENT`). Its command
environment was corrected before running the complete check again; no test was
edited or skipped to resolve that setup error.
