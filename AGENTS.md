# Instructions for coding agents (Codex)

This file holds the standing repository and agent rules. Each feedback-log entry is also a rule; follow it.

## Repository rules

- **Tests:** E2E first in `packages/butler-agent/rust/crates/butler-e2e`, stub tier. Non-E2E tests require `// test-category: <category>`: `race`, `security`, `pure-logic` or `format-pin`. Source-check ratchets `source-check-tests.txt`; counts may only go down. UI behavior uses harness/smoke tests, no unit tests or screen recordings.
- **Code shape:** files ≤500 lines, production functions ≤80 lines. OS-specific code only in `butler-platform`; no unsafe code. Keep code readable and minimal; never game checks.
- **Performance design:** No full scans on request paths, blocking I/O on Tokio workers (use `spawn_blocking`), or per-poll whole-file reads. Idle work must be change-driven.
- **E2E auth:** stub/replay only; live calls and authorized cassette recording use only the provider and model set in the `live-e2e` environment variables `BUTLER_E2E_LIVE_PROVIDER`/`BUTLER_E2E_LIVE_MODEL` (currently Z.AI GLM-5.3-Flash). Never hard-code one provider.
- **UI copy:** a few words, disabled state with tooltip, or brief toast; no banners. Korean: “예약 작업” (never “자동화”), “버틀러”. English: “schedule”.
- **Security:** never print tokens or widen access defaults. Approval cards show the exact action.
- **Issue links:** a PR body names each issue with a closing keyword (`Fixes #N`), or `Part of #N` / `Related #N` when it stays open; never a bare `#N` or `Refs #N`. The `issue-links` PR check reports violations, and merging into `release/**` also closes the `Fixes` issues.
- **Native dependencies:** static ORT recipe: [Rust README](packages/butler-agent/rust/README.md) and #293.
- **Self-hosted Windows runners:** use only the existing toolchain and job files in the workspace or `RUNNER_TEMP`; never run installer/setup actions, machine/user package installs, or registry, startup, service or PATH writes. Missing required tools must fail clearly, without installation.
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
- **Model calls.** Tests use stub or replay only. If a cassette must be re-recorded live, use only the model configured in `BUTLER_E2E_LIVE_MODEL` (currently Z.AI GLM-5.3-Flash), even when existing cassettes name other models.
- **TypeScript validation.** Do not run the full `bun run check`: it runs lifecycle-check, lint, typecheck and about 960 TS unit tests, and often reaches its 900-second limit.
  - For changes to `packages/butler-app/**`, `packages/butler-i18n/**` or any `*.ts`/`*.tsx`, run `bun run lint` and `bun run typecheck`. Run lifecycle-check only when UI lifecycle assets or inputs change, and run only TS tests covering the changed files.
  - For Rust-only changes, skip all Bun checks. E2E and real-app verification remain the primary evidence.
- **Root causes.** Fix the cause, not the symptom. Never skip, weaken or retry tests to get green. Never raise timeouts or loosen performance budgets. If you can't reproduce a failure, say so; don't claim a cause you haven't shown.
- **No special cases (zero tolerance).** Production code must never contain domain-specific or test-specific cases. That means no branches, strings, paths or names keyed to a test fixture, cassette, E2E command, acceptance scenario, site, app, owner value (host name, user name, folder) or CI environment. A fix must be a general rule that would also be correct for inputs no test uses. If only a special case makes a test pass, stop and report. Every Codex PR gets an independent review for this.
- **Scope discipline.** Do only the task. Report a problem only with evidence on the task's path (a reproduced failure or a measured number); no hypothetical or "potential" issues. Something clearly broken outside the task gets one line in the final message under "Out of scope, not touched"; no investigation, no fix. Touch only the files the task needs: no extra refactors, renames, cleanups or tests. Don't tune differences within noise (tens of ms or under ~5%) unless the task's stated budget is missed.
- **Performance failure criteria (owner, 2026-10-20).** Work on real problems, not numbers. Performance is a problem only when a user would actually notice it:
  - a visible stall or freeze;
  - typing or clicking that feels laggy;
  - waits of seconds the user sits through;
  - Butler holding the machine's CPU, memory, disk or network while the user does nothing.
  Keep perf checks, but put each failure line at an incident-level threshold: the point where the result is a real problem. A path that normally takes about 10 ms fails at a few hundred ms, not at 11 or 20 ms. Base each line on today's measured normal, an order of magnitude above it or where a user would notice, whichever comes first. A small change below that line, such as 10 ms becoming 20 ms, is not a failure, not a fix task and not an issue. Existing product budgets the owner set stay: startup, idle disk writes ≤1 MB/60 s, 1 s refusal latency. Test timeouts detect hangs only.
  - Idle cost is performance too. Never preload, prewarm or keep a resident worker or process for a speculative speedup, such as loading a model or spawning a spare shell. Load on demand. A rare wait of a few seconds is acceptable; a constant background cost is not.
- **Performance without cutting quality.** Meet a latency or throughput budget by doing less *work*, never by returning less *content*. Truncating, dropping fields, skipping items, lowering fidelity or serving stale cached data to pass a budget is a failure. Every timed perf check must also assert that the response is complete and correct (counts, order, latest state).
- **Main failures: fix it or don't file it.** Don't retry, skip, or mark tests ignored to get green. When a test fails on main without a code change, file a GitHub issue only together with a fix: the coordinator starts the fix task the same day, and the fix PR closes the issue with `Fixes #<n>`. One issue per root cause; comment on a matching open issue instead of filing another. Never file an issue only to justify a CI re-run; re-run only with that in-progress issue linked in a PR comment.
- **Before pushing:** Fetch origin and merge your base if it moved, then run `scripts/prepush`; it must pass; if TS/UI changed, also follow the TypeScript validation rule.
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

- **2026-10-28: Fix it or don't file it.** An issue for a main failure exists only while its fix is under way; the fix PR closes it with `Fixes #<n>`.
  - What happened: sessions filed an issue for each main failure to unlock a CI re-run, merged their own work and moved on. Nobody started the fixes, PRs that did fix them never closed them, and open issues went from 17 to 46 in eight days.

- **2026-10-20: Never kill by name pattern on shared hosts.** `pkill`/`killall` are blocked in WSL Codex tasks. Kill only PIDs you started and recorded.
  - What happened: a verification agent ran `pkill -f "cargo test"` on the shared WSL host and could have killed other sessions' test runs. Earlier, an agent killed an owner-PC PowerShell PID it only guessed was its own.

- **2026-10-16: Stay on the task; no invented issues, no noise-level tuning, no scope expansion.** Out-of-scope findings are one line, untouched.
  - What happened: worker runs repeatedly reported issues that did not exist, tuned 10-20 ms differences, and widened changes beyond the task's purpose.

- **2026-10-14: Focus rings must never be clipped.** A container that clips its content (overflow, clip-path, mask or edge fades) must leave `--focus-ring-room` for focus rings, and a card that clips its own content must draw the ring on the card. Run `bun run app:focus-ring:smoke` for any UI change.
  - What happened: the sidebar "새 대화" ring was cut on its left edge by the scroll frame. The same cut came back each time a new clipping container was added.

- **2026-10-10: Never tailor tool descriptions, prompts or product code to an acceptance scenario (named site, app, task recipe).** Acceptance tests measure general capability; fixes must be general.
  - What happened: browser tool descriptions accumulated Naver Map route and JSPaint drawing recipes while iterating to pass live acceptance runs.

- **2026-10-09: Spawned test Apps must not outlive the harness: stdio to a file, kill the child PID on every exit path.**
  - What happened: an orphaned smoke Electron (ppid 1) logged to a closed pipe and raised an EPIPE error dialog on the owner's screen.

- **2026-10-09: Never change DS components or blocks inside a product commit.** A change under `libs/design-system/{components,blocks,shadcn}` or the root DS CSS needs owner approval: a `DS-Approved: <who, when, where>` commit trailer or the `ds-approved` PR label. The `ds-approval` check fails, and blocks the merge, when both are missing. Fix a DS bug in the DS, never with a product-side workaround, and never edit a test only to match new CSS.
  - What happened: plain `DisclosureRow` titles sat at the top of the hover fill three times. The block was rewritten inside unrelated commits (`2278cb00b`, `92775d8cf`), the source-string test was edited to match, and an earlier fix (`12ada184c`) worked around it in one screen only.

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
- **2026-09-29: a cassette was recorded with the wrong model.** Use only the configured live model (`BUTLER_E2E_LIVE_MODEL`) for live recording.
  - What happened: a cassette was re-recorded with `gpt-6-sol`, copying the model named in older cassettes.
