# Session Worktree Visibility Report

Date: 2026-08-22

## Result

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
bind_session_git_worktree
-> Git worktree and exact branch checkout
-> durable SessionBindingStore CAS
-> App SessionView branch projection
-> Zustand active SessionSummaryView
-> titlebar and Summary inspector
```

The App owns only a reader connection to the durable binding store and closes
connections it creates. It does not repair or mutate bindings. Stale marked
worktrees remain unavailable and do not fall back to the project workspace.

## Validation

- Focused lifecycle, App recovery, Titlebar, and Summary tests: 24 passed,
  168 assertions.
- Root and UI typecheck: passed.
- Full lint, design token/component/CSS checks: passed.
- BTCC shape gate: passed, 4 domains / 307 files.
- UI production build: passed; the existing large-chunk warning remains.
- `git diff --check`: passed.
- VisualHarness desktop render: inspected with a deliberately long branch;
  titlebar controls remained unobstructed and Summary showed the same branch,
  session-worktree binding, and dirty state.

## Scope

No automatic worktree policy, worktree switcher, deletion UI, sidebar entry,
public filesystem path, Steward read-only policy, service deployment, or remote
operation was added.
