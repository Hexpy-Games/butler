---
name: project-ledger
description: Use a portable local Project Ledger CLI to inspect, query, render, and validate project-management records before reading broad project files.
user-invocable: false
applicability: Use when the model is operating inside a project session or decides that Project Ledger is the relevant source for project state, progress, roadmap, handoff, decisions, risks, work, or tasks.
allowed-tools: project-ledger-cli
dispatch: none
review: none
reporting: Reply with bounded status, next actions, blockers, stale views, or doctor findings; do not expose raw private records.
---

# Project Ledger

Use this skill when a project contains `.project-ledger/`, has a matching
external Project Ledger repository under `$PROJECT_LEDGER_REPO/projects/`,
`$BUTLER_PROJECT_LEDGER_REPO/projects/`, `$BUTLER_DATA/project-ledger/projects/`,
or `~/.butler/project-ledger/projects/`, or when the user asks to manage project
state, progress, roadmap, handoff, decisions, risks, work, or tasks through
Project Ledger. Butler project worktrees may omit a repo-local `.project-ledger/`
directory when their package name or folder name resolves to a live external
ledger record.

## Start Session Routine

1. Run:

   ```bash
   packages/project-ledger/bin/project-ledger status --project "$PWD" --json
   ```

2. Run:

   ```bash
   packages/project-ledger/bin/project-ledger query --project "$PWD" --kind next-actions --json
   ```

3. Read only the referenced specs, work items, decisions, or reports needed for
   the current task.

Do not read every project file to reconstruct status when Project Ledger can
answer the question.

## Close Work Routine

Before reporting completion, run:

```bash
packages/project-ledger/bin/project-ledger check --project "$PWD" --silent
```

If project views are useful, render them:

```bash
packages/project-ledger/bin/project-ledger render --project "$PWD" dashboard --write --json
packages/project-ledger/bin/project-ledger render --project "$PWD" handoff --write --json
packages/project-ledger/bin/project-ledger render --project "$PWD" roadmap --write --json
```

## Privacy

Do not copy raw private transcripts, credentials, raw prompts, raw tool payloads,
or private memory text into Project Ledger records, indexes, generated views, or
review prompts.

## Source Of Truth

Project Ledger records under `.project-ledger/` are the default source of truth
for standalone repos. For Butler-managed projects, the CLI resolves
`--project "$PWD"` to a matching external ledger repository first, such as
`$PROJECT_LEDGER_REPO/projects/butler` or
`~/.butler/project-ledger/projects/butler`, using repo-local project metadata,
package name, or folder name as routing hints. Generated view files are derived
views stored under the resolved ledger root.

The governing spec is `.project-ledger/specs/project-ledger.md`. The legacy
`docs/specs/project-ledger.md` path may exist as a compatibility symlink only.

## Work Recording

Use `work create`, `task create`, and `attempt start` when starting durable
work. Use `work complete` only after spec, acceptance, validation, review, and
report evidence exist.

For work that sets `requiresCommitEvidence: true`, `work complete` must also
include `codeCommits` evidence. Use `--code-commit auto` to collect the current
git HEAD, or pass `--code-commits` with a JSON array containing at least
`repo`, `hash`, and `message`.

## External Skill Install

Use `packages/project-ledger/bin/project-ledger install-skill --target
"$HOME/.codex/skills" --json` to link the repo-tracked skill into Codex.

## Docs Migration

When migrating an existing repo, use dry-run first:

```bash
packages/project-ledger/bin/project-ledger migrate-docs --project "$PWD" --json
```

Only use `--write` when the repo should make Project Ledger the source of truth
for supported project-management documents. Write mode moves supported `docs/`
files into `.project-ledger/` and leaves `docs/...` compatibility symlinks.
