# Instructions for coding agents (Codex)

This file holds the standing repository and agent rules. Each feedback-log entry is also a rule; follow it.

## Repository rules

- **Tests:** E2E first in `packages/butler-agent/rust/crates/butler-e2e`, stub tier. Non-E2E tests require `// test-category: <category>`: `race`, `security`, `pure-logic` or `format-pin`. Source-check ratchets `source-check-tests.txt`; counts may only go down. UI behavior uses harness/smoke tests, no unit tests or screen recordings.
- **Code shape:** files ≤500 lines, production functions ≤80 lines. OS-specific code only in `butler-platform`; no unsafe code. Keep code readable and minimal; never game checks.
- **Owner-scale performance:** design and verify against App DB ~1.3 GB, 600+ chats/~300k events, BTCC DB ~7 GB, 2,440 transcripts/1.5 GB (largest 290 MB), and metrics >300 MB. No full scans on request paths, blocking I/O on Tokio workers (use `spawn_blocking`), or per-poll whole-file reads. Idle work must be change-driven.
- **E2E auth:** stub/replay only; authorized live cassette recording uses only `openai/gpt-6-luna` with the owner's `~/.butler-e2e-auth` profile.
- **UI copy:** a few words, disabled state with tooltip, or brief toast; no banners. Korean: “예약 작업” (never “자동화”), “버틀러”. English: “schedule”.
- **Security:** never print tokens or widen access defaults. Approval cards show the exact action.
- **Native dependencies:** static ORT recipe: [Rust README](packages/butler-agent/rust/README.md) and #293.
- **Windows owner runners:** `butler-win` uses only the existing toolchain and job files in the workspace or `RUNNER_TEMP`; never run installer/setup actions, machine/user package installs, or registry, startup, service or PATH writes. Missing required tools must fail clearly, without installation.
- **Owner-machine procedure:** touch the live install, owner data, or port 18765 only when explicitly requested and the owner is present. Back up DBs first; stop gracefully with `butler-agent stop --data ~/.butler`. Never `pkill`/`killall`.

## Documents

Work plans, specs, reports, audits, handoffs, checkpoints and notes never go in the repo. Publish through `packages/project-ledger/bin/project-ledger` to `~/.butler/project-ledger/projects/butler`, following its `SYNC.txt`:

1. `git -C ~/.butler/project-ledger/projects/butler pull --ff-only` before mutations.
2. CLI `record create|update --project ~/.butler/project-ledger/projects/butler --kind <kind> --id <ID> --from "$TMPDIR/<file>"`; then `index`, `render dashboard|handoff|roadmap --write`, `status`, `check --verbose` with that project path.
3. Commit source records, `ledger.jsonl`, index and views together; push Ledger `main`. Stop on divergence; never force-push.

This routine requires Ledger access and publication authorization. Codex workers without Ledger permission put their plan/report in the final message; the coordinator publishes it. Scratch belongs in `$TMPDIR`, never the tree. The repo retains code, product READMEs, standing agent rules, release notes and explicitly allowed source assets.

## Working rules

- **Isolation.** Run every test and check command with `HOME` and `BUTLER_DATA` pointed at a fresh temp dir. This covers Bun lint/typecheck, lifecycle-check, targeted TS tests, `cargo test`, `cargo nextest` and E2E. Use, for example, `export HOME=$(mktemp -d) BUTLER_DATA=$(mktemp -d)` in the same shell.
  - Never read or write the owner's real `~/.butler`, unless the task explicitly grants read access.
  - Never touch port 18765, `~/Applications/ButlerAgent`, or launchd services.
- **Scope.** Write only inside your worktree, plus the build caches (`~/.cargo`, `~/.bun`, temp dirs). Never kill processes by name pattern (`pkill`, `killall`); kill only PIDs you started. Never print tokens or keys.
- **Model calls.** Tests use stub or replay only. If a cassette must be re-recorded live, use only `openai/gpt-6-luna`, even when existing cassettes name other models.
- **TypeScript validation.** Do not run the full `bun run check`: it runs lifecycle-check, lint, typecheck and about 960 TS unit tests, and often reaches its 900-second limit.
  - For changes to `packages/butler-app/**`, `packages/butler-i18n/**` or any `*.ts`/`*.tsx`, run `bun run lint` and `bun run typecheck`. Run lifecycle-check only when UI lifecycle assets or inputs change, and run only TS tests covering the changed files.
  - For Rust-only changes, skip all Bun checks. E2E and real-app verification remain the primary evidence.
- **Root causes.** Fix the cause, not the symptom. Never skip, weaken or retry tests to get green. Never raise timeouts or loosen performance budgets. If you can't reproduce a failure, say so; don't claim a cause you haven't shown.
- **Performance without cutting quality.** Meet a latency or throughput budget by doing less *work*, never by returning less *content*. Truncating, dropping fields, skipping items, lowering fidelity or serving stale cached data to pass a budget is a failure. Every timed perf check must also assert that the response is complete and correct (counts, order, latest state).
- **Flaky tests.** Don't retry, skip, or mark tests ignored to get green. A test that fails on main without a code change gets a GitHub issue the same day and a fix within 48 hours. Re-run CI only with that issue linked in a PR comment.
- **Before pushing:**
  - `git fetch origin` and merge your base (`origin/main` or the named `origin/release/<v>`) if it moved;
  - run `cargo fmt`, `clippy -D warnings` on touched crates, and `cargo run -p butler-source-check -- .`;
  - if TS or UI changed, follow the TypeScript validation rule above, isolated as above.
- **Pushing.** Push only when the task allows it. When the task includes a PR, after pushing confirm with `gh pr checks <n>` that checks started. GitHub runs no `pull_request` checks while a PR has merge conflicts.
- **Final message:**
  - what changed;
  - each check and test you ran, with its result;
  - measured numbers;
  - anything left undone, with file:line.

  Don't leave scratch files such as a PR body or notes in the tree.

## Branches and pushing

- Branch from `origin/main` as `<type>/<slug>`: `feat`, `fix`, `perf`, `refactor`, `ci`, `build`, `docs`, `test`, `chore` or `research`. Name the work, never the tool; `codex/`, `claude/` and other agent prefixes are forbidden. `branch-name` checks every PR head, including forks. There are no bot exceptions in this repo.
- Only when the task names a release branch, branch from `origin/release/<v>` as `fix/<v>-<slug>`. Release branches are `release/<v>`, where `<v>` is `X.Y.Z` or `X.Y.Z-preview.N`.
- Push only your own branch. Never push to `main` or `release/**`, create or delete release branches or `v*` tags, or merge PRs.
- Open a PR only when the task asks. Its base is `main`, or the release branch named in the task; otherwise the coordinator batches branches.
- Before pushing, fetch and merge your base if it moved. Never rebase a pushed branch.
- PRs and main pushes run smoke CI, without E2E or perf. Run the existing stub E2E and perf tests covering your changed paths locally, isolated, and report every result.
- Cherry-pick into a release fix only when asked, with `-x`. Release fixes return to main through a merge-back PR, using a merge commit.
- Never add workflow branch allowlists or advisory flags. A coordinator can waive a named known-flaky failure for a preview in an open issue, then notify the owner. Stable waivers require the owner's approval. Follow the waiver record format in CONTRIBUTING.md.

## Recurring mistakes (feedback log)

Newest first. The coordinator adds an entry whenever a mistake repeats. Each entry gives the rule, then what happened.

- **2026-10-07: Owner-PC runners: never use installer/setup actions or registry/PATH writes; use the existing toolchain.**
  - What happened: `actions/setup-python` tried to rewrite Python registry registrations on the owner PC, logged a permission error and hung until the 90-minute job timeout (run 37560002889).

- **2026-10-07: Scope TypeScript validation to changed paths.** Do not run the full `bun run check`; use lint, typecheck, lifecycle-check when relevant, and tests covering changed files.
  - What happened: the full command runs about 960 TS unit tests and often reaches its 900-second limit.

- **2026-10-06: Work documents belong only in the Project Ledger.**
  - What happened: work docs accumulated in `plans/`, root and `rust/docs`; moved to the ledger.

- **2026-10-03: UI changes must include before/after screenshots of every screen they can affect.** Check shared DS blocks in both themes, desktop/mobile, wallpaper/plain, and pending/completed onboarding against the existing screen before accepting a visual change.
  - What happened: preview.7 captain commit `83ac46d41` added an opaque hero Card and opaque suggestion fills to the shared `PromptSuggestionList`. The onboarding captures asserted the new opacity but did not compare completed new-chat screens against preview.6; the unrelated screen changed and the mark overlapped the new box.

- **2026-10-01: Search open issues before filing one.** Run `gh issue list --search "<test name or file>"` and comment on a matching issue instead of opening a duplicate.
  - What happened: the same seven Linux Bun failures were filed four times (#352, #371, #388, #394).

- **2026-10-01: Run the existing tests that cover the paths you touched, not only your new tests.** Before pushing, find tests that exercise the files/behaviors you changed (`rg` for the module, config file, CLI command or data-dir writes) and run them.
  - What happened: lang-eol-defaults ran only its 17 new E2Es and missed the config durability test and MIG-01 (a refused legacy data dir was modified); pairing changed the CLI surface without running cli_surface.

- **2026-10-01: Shutdown paths: test the full queue (active turn plus queued follow-ups), not only the active turn.**
  - What happened: Q-02 left a follow-up permanently failed after restart; queue recovery raced executor readiness and shutdown errors had no pending recovery path.

- **2026-09-30: running checks against the real home dir.** Isolate every check and test run (see Isolation).
  - What happened: `bun run check` ran without a temp `HOME`/`BUTLER_DATA`, and the Project Ledger tests tried to write under `~/.butler`. The sandbox blocked it twice (tasks sync-329 and ratchet-324).
  - The same test gap had earlier left about 1,400 fixture dirs (720 MB) in the owner's real `~/.butler/project-ledger/projects/`.
- **2026-09-30: missing PR checks went unnoticed.** When `gh pr checks` lists nothing, look for a merge conflict before you report success.
  - What happened: a push to a conflicting PR produced no checks, and the task reported it as done.
- **2026-09-29: a scratch file was left in the tree.** Keep PR-body drafts in the PR itself.
  - What happened: a PR-body draft was committed under `plans/`.
- **2026-09-29: plan items were skipped silently.** Deliver every plan item, or list it as left undone with the reason.
  - What happened: a plan's acceptance items (a chat-tool E2E and an idle-read measurement) were skipped without being called out.
- **2026-09-29: a cassette was recorded with the wrong model.** Use only `openai/gpt-6-luna` for live recording.
  - What happened: a cassette was re-recorded with `gpt-6-sol`, copying the model named in older cassettes.
