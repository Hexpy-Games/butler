# PR checks by changed inputs

Every PR workflow starts with `changes`. It compares the complete checkout with
`pull_request.base.sha`, using a NUL-delimited Git diff with rename detection
disabled so both sides of a rename select their owners. Merge groups use their
base SHA. Schedules and manual checks retain full coverage. No workflow-level PR
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

The next run checks up to the latest 100 runs of that same workflow. A receipt
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

Local regression checks: eight tests in `.github/scripts/test-ci-changes.py`,
including receipt ownership of every selected gate check across all 128 flag
combinations, and the existing
`Gate`/`ArtifactTrust` tests from `.github/scripts/test-ci-invariants.py`. All run
through `.github/scripts/isolated.py`, which disposes HOME/BUTLER_DATA while
retaining tool caches. Actionlint validates every workflow and local action.

Real draft-PR observations will be recorded here after the runs complete. The
implementation changes workflows, so its initial run must exercise all owners
before subsequent isolated UI/Rust commits can reuse the corresponding proofs.
