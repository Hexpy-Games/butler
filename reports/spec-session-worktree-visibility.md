# Session Worktree Visibility

Status: implemented 2026-08-22

## Intent lock

- A project session that is bound to a session-owned Git worktree must be
  recognizable without opening the inspector.
- Every newly created project session must create and durably bind its own
  linked Git worktree before the public create-session request succeeds.
- The worktree creation operation must also create or select the session branch
  and leave that branch checked out as the worktree's symbolic `HEAD`.
- The desktop titlebar is the persistent primary indicator.
- The Summary inspector must expose the same durable binding, branch, Git
  availability, and clean/dirty state.
- Creating a session worktree and checking out its requested branch are one
  operation. A binding is not successful unless the linked worktree validates
  with that branch as its symbolic `HEAD`.

## Authority and public path

`SessionBindingStore` remains the sole durable workspace-binding authority.

```text
POST /sessions for a project session
-> create the App session record
-> seed its canonical runtime SessionBinding
-> bind_session_git_worktree
-> git worktree add/create and requested branch checkout
-> exact branch/worktree validation
-> durable session binding CAS
-> App /session-view and /session-summary
-> current Zustand SessionSummaryView
-> desktop titlebar and Summary inspector
```

The project-session creation workflow may seed and bind the new session before
acknowledging creation. After admission, the App projection is read-only and
Agent recovery remains the only worktree recovery authority.

Existing project sessions are not retroactively migrated. Ordinary chat
sessions without a project keep their existing workspace policy.

## Provisioning contract

- The generated branch is deterministic for the admitted session ID and uses
  the safe `butler/session/<session-id>` namespace.
- The linked worktree target remains under Butler's existing private
  `worktrees/sessions` root; neither it nor the repository anchor is public.
- Creation runs under the local App/Agent user and uses the existing direct Git
  argv adapter. macOS, Linux, and Windows share this contract. A project folder
  without Git, or a host without Git, keeps the established project-workspace
  behavior and safe capability status because no worktree can be created.
- The public request stays pending while Git and the durable binding complete.
  A server shutdown or cancellation follows the same failed-admission cleanup.
- Exactly one acknowledged session owns the generated branch/worktree binding.
  Reopening or messaging that session recovers the durable marker; it does not
  create another worktree.
- The creation workflow owns compensation across the App record and provisional
  runtime binding. A failed provision removes both before returning the safe
  error. A successfully bound worktree is never reported as a project workspace.

## UX contract

- An active session-worktree binding adds a Git-branch icon and a compact
  `Worktree · <branch>` label to the desktop titlebar.
- A new project session does not become visible as successfully created until
  its linked worktree and checked-out branch are durably bound.
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
7. The real public `POST /sessions` project-session path creates one durable
   runtime binding and one linked worktree whose symbolic `HEAD` is the
   generated session branch; `/session-view` immediately projects that binding.
8. Ordinary chat creation does not create a linked worktree, and existing
   unmarked sessions continue to project their project workspace.
9. If provisioning a detected Git repository fails, the public request fails
   with a safe typed error and the newly inserted App session and provisional
   runtime binding are removed. A non-Git project or missing Git remains an
   explicit project-workspace capability state, not a claimed worktree.

## Non-goals

- No retroactive migration of existing sessions.
- No worktree switcher, deletion UI, sidebar row, or new workspace authority.
- No public filesystem paths or repository anchors.
- No change to read-only Steward workspace policy.
