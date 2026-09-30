# Instructions for coding agents (Codex)

Read [plans/README.md](plans/README.md) first. It holds the repo rules: test policy, code-shape limits, the platform rule and performance at owner scale. This file adds the working rules for agent-run tasks. It ends with a log of mistakes that agents have repeated. Each log entry is a rule; follow it.

## Working rules

- **Isolation.** Run every test and check command with `HOME` and `BUTLER_DATA` pointed at a fresh temp dir. This covers `bun run check`, `cargo test`, `cargo nextest` and E2E. Use, for example, `export HOME=$(mktemp -d) BUTLER_DATA=$(mktemp -d)` in the same shell.
  - Never read or write the owner's real `~/.butler`, unless the task explicitly grants read access.
  - Never touch port 18765, `~/Applications/ButlerAgent`, or launchd services.
- **Scope.** Write only inside your worktree, plus the build caches (`~/.cargo`, `~/.bun`, temp dirs). Never kill processes by name pattern (`pkill`, `killall`); kill only PIDs you started. Never print tokens or keys.
- **Model calls.** Tests use stub or replay only. If a cassette must be re-recorded live, use only `openai/gpt-6-luna`, even when existing cassettes name other models.
- **Root causes.** Fix the cause, not the symptom. Never skip, weaken or retry tests to get green. Never raise timeouts or loosen performance budgets. If you can't reproduce a failure, say so; don't claim a cause you haven't shown.
- **Before pushing:**
  - `git fetch origin` and merge `origin/main` if it moved;
  - run `cargo fmt`, `clippy -D warnings` on touched crates, and `cargo run -p butler-source-check -- .`;
  - if TS or UI changed, run `bun install --frozen-lockfile --ignore-scripts && bun run check`, isolated as above.
- **Pushing.** Push only when the task allows it. After pushing, confirm with `gh pr checks <n>` that checks started. GitHub runs no `pull_request` checks while a PR has merge conflicts.
- **Final message:**
  - what changed;
  - each check and test you ran, with its result;
  - measured numbers;
  - anything left undone, with file:line.

  Don't leave scratch files such as a PR body or notes in the tree.

## Recurring mistakes (feedback log)

Newest first. The coordinator adds an entry whenever a mistake repeats. Each entry gives the rule, then what happened.

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
