# Work Activity Timeline

Butler work execution now treats Worker and Steward progress as a durable work timeline rather than a command-only log.

## Purpose

The timeline exists to make internal work inspectable without exposing hidden reasoning. A Worker or Steward should leave the same kind of safe work record that the main Butler session leaves before native tool calls:

- what it is about to do,
- why that step matters now,
- what the next step should use from the result,
- which semantic state the work is in,
- which action kind was actually performed,
- which evidence supports completion.

The timeline is append-only evidence. Compact activity projection remains useful for UI summaries, but it must not be the source of truth for what happened.

## Roles

- **Butler** is the principal-facing orchestrator.
- **Steward** is an internal project/workstream custodian session role, not a separate principal-facing actor.
- **Worker** is a task execution attempt.

They do not need identical authority, but their work progress should be recorded with compatible timeline events so the app can render Worker and Steward work in a chat-like inspection view.

## Semantic phase vs action kind

Semantic phase is the state-machine meaning of the step. Action kind is the operation performed inside that state.

Examples:

| Semantic phase | Meaning |
| --- | --- |
| `orienting` | Establish task/session context. |
| `planning` | Decide the execution approach. |
| `inspecting` | Read, search, or list state to narrow scope. |
| `executing` | Create, edit, patch, or otherwise produce the requested work output. |
| `verifying` | Check the output against acceptance criteria. |
| `committing` | Stage or commit the reviewed change set. |
| `consolidating` | Summarize evidence and residual risk. |
| `reporting` | Produce the safe public or parent-session report. |
| `blocked` | Record a real blocker that prevents progress. |

Action kind is tool/operation shaped, for example `read_file`, `search`, `list_files`, `run_command`, `edit_file`, `apply_patch`, `git_status`, `git_diff`, `test`, `typecheck`, `commit`, or `report`.

A command does not decide semantic phase. `grep` can happen while inspecting or verifying. `git diff` can be a local implementation self-check or a final verification step. The current state-machine context decides the semantic phase; command classification only supplies action-kind metadata and safe labels.

## Completion contract

Butler must not add a special "research loop detector" just because a Worker reads many files. Completion is judged by the task's contract and evidence.

For implementation tasks, completion requires implementation evidence such as one or more of:

- file creation,
- file modification,
- patch application,
- a non-empty diff before commit,
- test or validation changes,
- a commit,
- or a clear blocker event explaining why implementation cannot proceed.

A task that only inspects and reports may be complete if the task is a discovery/audit task. The same inspection-only result must not satisfy an implementation task unless the task contract explicitly says no code change is required and records why.

## Storage and projection

Timeline events should be durable and append-only. UI projections may compact these events into the latest activity row, current phase, status line, and evidence counters. Projection is a derived view, not the audit source.

The app viewer surfaces Worker/Steward timeline details through the task protocol so a principal can inspect progress as a chat-like work timeline instead of only seeing final summaries and command traces.

## Verification checklist

The current WATL implementation is validated by:

```bash
bun test tests/unit/worker-activity-projection.test.ts \
  tests/unit/worker-activity-semantic-phase.test.ts \
  tests/unit/worker-activity-completion-contract.test.ts \
  tests/unit/app-client-project-documents.test.ts

npm run typecheck
npm --prefix packages/butler-app/client/ui run build
```

When e2e validation is required, run it against a cloned Butler home/data pair so live Butler state is not modified.

## Closeout notes

- Do not create repo-local `.project-ledger`; Project Ledger state belongs under Butler Home data.
- Keep legacy activity projection compatible while adding timeline detail fields.
- Keep hidden reasoning out of timeline events. Store safe work decisions, not raw chain-of-thought.
