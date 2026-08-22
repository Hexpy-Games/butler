# Session Worktree Visibility

Status: implemented 2026-08-22

## Intent lock

- A project session that is bound to a session-owned Git worktree must be
  recognizable without opening the inspector.
- The desktop titlebar is the persistent primary indicator.
- The Summary inspector must expose the same durable binding, branch, Git
  availability, and clean/dirty state.
- Creating a session worktree and checking out its requested branch are one
  operation. A binding is not successful unless the linked worktree validates
  with that branch as its symbolic `HEAD`.

## Authority and public path

`SessionBindingStore` remains the sole durable workspace-binding authority.

```text
bind_session_git_worktree
-> git worktree add/create and requested branch checkout
-> exact branch/worktree validation
-> durable session binding CAS
-> App /session-view and /session-summary
-> current Zustand SessionSummaryView
-> desktop titlebar and Summary inspector
```

The App may read the durable binding but must not repair, recreate, or mutate
it. Agent recovery remains the only worktree recovery authority.

## UX contract

- An active session-worktree binding adds a Git-branch icon and a compact
  `Worktree · <branch>` label to the desktop titlebar.
- Long branch labels truncate through the existing titlebar layout and must not
  displace window or session controls.
- Project workspaces do not show the worktree indicator.
- The Summary inspector shows the binding kind, branch, availability, and
  clean/dirty state from the same SessionView snapshot.
- An unavailable marked worktree remains visibly unavailable and never falls
  back to the project workspace.
- Filesystem paths, repository anchors, and private runtime session IDs are not
  included in the public protocol or UI.

## Acceptance criteria

1. A real App server SessionView reports `session_worktree`, its branch, safe
   label, availability, and dirty state after the production bind operation.
2. The same information survives App server restart by reopening the durable
   session binding store.
3. A stale marked worktree reports unavailable without exposing a path or
   presenting the project workspace as active.
4. The titlebar renders the branch icon and safe worktree label only for the
   active session whose current SessionView is worktree-bound.
5. The Summary inspector renders the same branch and binding information.
6. Worktree creation tests prove the target worktree has the requested branch
   checked out before the durable binding is accepted.

## Non-goals

- No automatic worktree creation for every project session.
- No worktree switcher, deletion UI, sidebar row, or new workspace authority.
- No public filesystem paths or repository anchors.
- No change to read-only Steward workspace policy.
