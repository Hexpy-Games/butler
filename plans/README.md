# Execution plans for Codex

> **Canonical copy:** Butler's Project Ledger, `butler` project (`~/.butler/project-ledger/projects/butler`). IDs: `SPEC-BUTLER-0-1-0`, `HANDOFF-CLAUDE-CODEX-20260929`, `PLAN-0-1-0-REMAINING`, `PLAN-0-1-0-01`…`13`, `PLAN-POST-0-1-0`, `PLAN-EMBEDDING-MODEL`. The files here are working mirrors. After changing a plan, publish it with `BUTLER_DATA=~/.butler packages/project-ledger/bin/project-ledger plan update --project . --id <ID> --from <file>`, or `record update --kind spec|handoff`.

The owner writes plans with Claude Code, and Codex executes them. Agents also follow [AGENTS.md](../AGENTS.md), which holds the working rules and a log of repeated mistakes. Each file is one unit of work. Work top to bottom inside a folder.

## How to execute a plan

1. Branch from latest `origin/main` as `<type>/<slug>` (see AGENTS.md). If the plan names `release/<v>` in **Start from**, branch from `origin/release/<v>` as `fix/<v>-<slug>`. Tool-named prefixes such as `codex/` and `claude/` are forbidden.
2. Read the plan's **Context** section, then check every file:line reference against current main. They were recorded on 2026-09-29, so line numbers may have drifted.
3. Implement in the order given. Keep the diff scoped to the plan.
4. Meet every **Acceptance** check, then open a PR that links the plan file and any issue it names.
5. Tick the plan's checkbox in `plans/0.1.0/00-index.md` (or `plans/post-0.1.0/00-index.md`) in the same PR.

## Repo rules (CI enforces most)

- **Tests:** E2E first, in `crates/butler-e2e`, on the stub tier.
  - Non-E2E tests are allowed only in four categories: `race`, `security`, `pure-logic` or `format-pin`. Tag each one `// test-category: <cat>`.
  - `tools/source-check` ratchets the test counts in `source-check-tests.txt`; counts may only go down.
  - UI work gets no unit tests or screen recordings. Use harness or smoke tests only when they prove behavior.
- **Code shape:**
  - Files are ≤500 lines and production functions ≤80 lines (source-check).
  - OS-specific code lives only in `crates/butler-platform` (#260).
  - No `unsafe` (the workspace forbids it).
  - Readable, minimal code. No metric gaming; for example, no fake labels to pass checks.
- **Performance is part of correctness.** Design and verify at owner scale:
  - App DB about 1.3 GB, 600+ chats, ~300k events;
  - BTCC DB about 7 GB;
  - 2,440 transcripts, 1.5 GB total, the largest 290 MB;
  - metrics files over 300 MB.

  Specific rules:
  - No full scans on request paths.
  - No blocking I/O on tokio workers; use `spawn_blocking`.
  - No per-poll whole-file reads.
  - Idle work must be change-driven.
- **Model calls in tests:** stub or replay only. For live re-recording, use only `openai/gpt-6-luna` (effort max is fine), never sol or astra. Use the owner's test auth profile at `~/.butler-e2e-auth`.
- **Isolation:** tests and tools never read or write the real `~/.butler`. Use temp HOME and `BUTLER_DATA`.
- **UI copy:**
  - Keep it terse: a few words, disabled state plus tooltip, or a brief toast. No banners.
  - Korean terms: "예약 작업" (never "자동화"), "버틀러".
  - English: "schedule".
- **Security:** never print tokens, and never widen access defaults. Every approval card must show the exact action.
- **Checks before pushing:**
  - `cargo fmt`
  - `cargo clippy -D warnings` on the touched crates
  - `cargo run -p butler-source-check -- .`
  - `bun install && bun run check`
- **Native deps:** building needs the ORT static library. The recipe is in `packages/butler-agent/rust/README.md` and #293.

## Owner-machine steps

A plan marked **OWNER-MACHINE** touches the owner's live install: `~/Applications/ButlerAgent`, `~/.butler`, port 18765. Do these steps only when the owner asks and is present.
- Stop the service gracefully with `butler-agent stop --data ~/.butler`.
- Never use `pkill` or `killall`.
- Back up the DBs first.
