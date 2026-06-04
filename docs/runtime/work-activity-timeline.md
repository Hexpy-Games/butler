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

Completion obligations are satisfied by structured tool-audit evidence, not only by final-answer prose. If a state-inspection tool is the requested source of truth, its successful audit contract can satisfy `source_verified`; Project Ledger status/query inspection also counts as verified state evidence when it returns a bounded state result such as `not_initialized`. The final review loop must not keep retrying solely because the evidence came from a capability contract rather than a separate evidence receipt.

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

For an Electron app smoke check, follow the app execution flow instead of only inspecting task files:

1. Use an isolated Butler state clone. Install client dependencies once with `npm run app:client:install`, then launch the built Electron client from the repo root with `BUTLER_HOME=/path/to/cloned-home BUTLER_DATA=/path/to/cloned-data npm run app:client`. The Electron main process starts or connects to the local app gateway.
2. If you need the Vite dev renderer, start the gateway first in one terminal with the same `BUTLER_HOME`/`BUTLER_DATA` via `npm run app:server`, then launch `BUTLER_APP_SERVER_URL=http://127.0.0.1:18765 npm run app:client:dev` in another terminal. Treat `Butler app server is not healthy` or early gateway exits in the terminal logs as launch blockers.
3. In the Electron app, open the target chat/project, submit a small request that dispatches a Worker or Steward task, and keep the new turn selected while it runs so progress updates stream into the disclosure.
4. While the task is active, inspect the latest turn's `Progress history` / work activity disclosure (`Open ... details` or `Open ... progress items`). Confirm the worker timeline shows an active phase/status, a safe current activity label, and ordered detail/tool-run rows without hidden reasoning or raw prompts.
5. Let the task finish, then reopen the same chat/project and confirm the status is complete and the timeline remains visible from the task protocol projection.
6. Treat a missing work activity disclosure, empty timeline detail rows, or no phase/activity updates during an active task as an absence signal to investigate.

## Closeout notes

- Do not create repo-local `.project-ledger`; Project Ledger state belongs under Butler Home data.
- Keep legacy activity projection compatible while adding timeline detail fields.
- Keep hidden reasoning out of timeline events. Store safe work decisions, not raw chain-of-thought.
