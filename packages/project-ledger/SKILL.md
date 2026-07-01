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

Use this skill when a project has a matching Project Ledger repository under
`$BUTLER_DATA/project-ledger/projects/`, `~/.butler/project-ledger/projects/`,
`$PROJECT_LEDGER_REPO/projects/`, or `$BUTLER_PROJECT_LEDGER_REPO/projects/`,
or when the user asks to manage project state, progress, roadmap, handoff,
decisions, risks, work, or tasks through Project Ledger.

## Start Session Routine

1. Start with the bounded status surface:

   ```bash
   packages/project-ledger/bin/project-ledger status --project "$PWD" --json
   ```

   When the short UX is available, `pl status --project "$PWD" --json` is the
   equivalent interactive form.

2. Query the next bounded work set before opening broad source files:

   ```bash
   packages/project-ledger/bin/project-ledger query --project "$PWD" --kind next-actions --json
   ```

   When the short UX is available, `pl list next-actions --project "$PWD"
   --json` is the equivalent selection step. Use `pl list <kind> --status
   STATE --json` only when you intentionally need a narrower record-kind
   filter.

3. Read only the referenced specs, work items, decisions, or reports needed for
   the current task.

Do not read every project file to reconstruct status when Project Ledger can
answer the question.

## Mutation Routine

Every Project Ledger mutation must go through the Project Ledger CLI or native
Project Ledger tools. Do not create, replace, patch, or edit Project Ledger
source records directly with generic file tools, shell redirection, or ad hoc
Markdown edits.

Use `work create`, `task create`, and `attempt start` when starting durable
work. Use `record create|update`, `spec update`, `plan create|update`,
`work update|complete`, `task update|complete`, and `attempt succeed|fail`
for record changes. Keep generated views as outputs of `render --write`, not
manual edits.

## Close Work Routine

Before reporting completion, run:

```bash
packages/project-ledger/bin/project-ledger index --project "$PWD" --json
packages/project-ledger/bin/project-ledger render dashboard --project "$PWD" --write --json
packages/project-ledger/bin/project-ledger render handoff --project "$PWD" --write --json
packages/project-ledger/bin/project-ledger render roadmap --project "$PWD" --write --json
packages/project-ledger/bin/project-ledger status --project "$PWD" --json
packages/project-ledger/bin/project-ledger check --project "$PWD" --verbose --json
```

Run `status` and `check` after index/render, sequentially, so stale generated
views are not confused with current source-record problems.

Short UX equivalents:

```bash
pl index --project "$PWD"
pl render dashboard --project "$PWD" --write
pl render handoff --project "$PWD" --write
pl render roadmap --project "$PWD" --write
pl status --project "$PWD" --json
pl check --project "$PWD" --verbose
```

## Privacy

Do not copy raw private transcripts, credentials, raw prompts, raw tool payloads,
or private memory text into Project Ledger records, indexes, generated views, or
review prompts.

## Source Of Truth

Project Ledger records under `$BUTLER_DATA/project-ledger/projects/<id>/` are
the default source of truth. The CLI resolves `--project "$PWD"` to a matching
data-home ledger, such as `~/.butler/project-ledger/projects/butler`, using
package name or folder name as routing hints. Generated view files are derived
views stored under the resolved ledger root.

The governing spec lives under the resolved ledger root, for example
`project-ledger/projects/butler/specs/project-ledger.md`. Legacy `docs/...`
paths may exist as compatibility symlinks only.

## Work Recording

Create or select work before implementation. Use `work complete` only after
spec, acceptance, validation, review, and report evidence exist.

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

Only use `--write` when Project Ledger should become the source of truth for
supported project-management documents. Write mode moves supported `docs/` files
into the resolved data-home ledger root and leaves `docs/...` compatibility
symlinks.
