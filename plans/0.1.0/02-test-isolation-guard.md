# 02. Tests never touch `$HOME/.butler` (P0)

**Start from:** `claude/tests-never-touch-home`. Its draft PR body lists the offending tests that have been found so far.

## Context
The owner's real `~/.butler/project-ledger/projects/` held 1,386 test-fixture directories (`project-ledger-state-XXXXXX`, `project-ledger-event-log-XXXXXX`, about 750 MB). New ones were still being created on 2026-09-29 while agents ran `cargo test`. Those directories were deleted. About 19 `project-ledger-fixture-*`, `project-ledger-repair-check.*`, `r24-clean-ledger.*` and `butler-ledger-check-*` directories may remain; plan 13 cleans them up.

## Steps
1. Find every test that resolves the data root, ledger root or HOME. Cover Rust unit and integration tests, butler-e2e, and TS `bun test`.
   - Search for `project-ledger-state-`, `project-ledger-event-log-` and `project-ledger-fixture`.
   - Search for ledger root resolution, `dirs::home_dir`, `HOME`, `user_dirs` and the default data root.
2. Point each of those tests at a temp root.
3. Add a guard. In test builds, resolving the default data root or ledger root panics unless a temp root was set explicitly. Pick one mechanism that works for unit tests, integration tests and butler-e2e: `cfg(test)`, a test-support helper, or a `BUTLER_TEST` marker.
4. butler-e2e sets HOME, `BUTLER_DATA` and the XDG directories to temp paths for every process it spawns.
5. Add a CI step that runs after the tests and fails if the runner's `~/.butler` exists or has changed.

## Acceptance
- Before and after running the whole test suite locally with the real HOME, the count of entries in `~/.butler/project-ledger/projects` is unchanged.
- One `security`-tagged test proves the guard panics.
- The CI step passes.
