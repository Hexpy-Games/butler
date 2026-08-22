# Session Worktree Visibility Report

Date: 2026-08-22

## Result

Correction: the initial delivery only surfaced an already-bound worktree and
explicitly excluded automatic project-session provisioning. Runtime inspection
showed that a newly created App project session therefore remained on the shared
project workspace and had nothing for the titlebar to display.

The real `POST /sessions` project path now creates the App session provisionally,
seeds its canonical runtime binding, creates a linked worktree with the
deterministic `butler/session/<session-id>` branch checked out, validates that
symbolic `HEAD`, and only then publishes/acknowledges the session. The first
queued App Turn preserves the marked worktree instead of overwriting it with the
project root.

Non-Git folders and hosts without Git preserve the established project-workspace
capability state. Other Git provisioning failures remove the provisional App
record and runtime binding and return a typed safe error.

The App now reads the existing durable session workspace binding when it builds
`/session-view` and `/session-summary`. A worktree-bound active session exposes
only its safe branch, binding kind, availability, and clean/dirty state.

The desktop titlebar renders a Git-branch icon and compact
`Worktree · <branch>` label for that active session. The existing Summary
inspector renders the same snapshot as `Session worktree`, branch, and change
state. Long branch text truncates inside the existing titlebar identity region
without moving session or window controls.

Worktree creation continues to use the existing single operation. The bind is
accepted only after the linked target validates that its symbolic `HEAD` is the
requested branch; the acceptance test now asserts that checkout explicitly.

## Public path reviewed

```text
POST /sessions
-> provisional App session
-> canonical runtime SessionBinding
-> bind_session_git_worktree
-> Git worktree and exact branch checkout
-> durable SessionBindingStore CAS
-> publish session.created and return 201
-> App SessionView branch projection
-> Zustand active SessionSummaryView
-> titlebar and Summary inspector
```

The App opens the durable binding store lazily: ordinary reads do not create an
Agent database, while new Git-backed project-session admission seeds and binds
the one new record. After admission, projection stays read-only. Stale marked
worktrees remain unavailable and do not fall back to the project workspace.

## Validation

- Focused public creation/recovery, Titlebar, and Summary tests: 13 passed,
  122 assertions.
- App server project/session and App-transport regressions: 9 passed,
  63 assertions.
- Full App server suite: 192 passed / 1 pre-existing source-contract test
  failed. The residual expects an obsolete `interface CreateAppServerOptions`
  declaration that was already a type alias at the correction base; no runtime
  App-server test failed.
- Root and UI typecheck: passed.
- Full lint, design token/component/CSS checks: passed.
- BTCC shape gate: passed, 4 domains / 307 files.
- UI production build: passed; the existing large-chunk warning remains.
- `git diff --check`: passed.
- VisualHarness desktop render: inspected with a deliberately long branch;
  titlebar controls remained unobstructed and Summary showed the same branch,
  session-worktree binding, and dirty state.

## Scope

Automatic provisioning applies only to newly created Git-backed project
sessions. Existing sessions are not migrated. No worktree switcher, deletion
UI, sidebar entry, public filesystem path, Steward read-only policy, or remote
operation was added.
