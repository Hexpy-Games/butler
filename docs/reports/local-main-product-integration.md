# Local main product integration

Status: Integration specification approved for execution on 2026-08-16.

## Accepted intent

Preserve the 18 product commits developed directly on local `main` after
`549463fb`, integrate them with the latest `origin/main`, and publish the result
as a reviewable pull request. The local `main` ref must remain at `dd19567b`
until a later explicit decision.

The integration must preserve both lines of product behavior:

- local line: explicit Turn/Work relations and disposition, audited correction,
  live App reconciliation, multimodal image carriers, provider reconnect status,
  and generated/workspace artifact delivery;
- upstream line: quota reporting, session worktrees, native workspace file
  operations, runtime-memory remediation, interrupted-Turn recovery, literal
  tokenizer handling, opaque session-view cursor recovery, bounded Ledger
  publication, and Z.AI GLM-5.3 support.

## Canonical product paths

1. App message ingress -> App Gateway session/transport stores -> BTCC Turn and
   Work execution -> provider route -> terminal projection and live App view.
2. App attachment ingress -> verified image/file carrier -> provider/tool use ->
   generated or workspace artifact publication -> durable chat attachment.
3. Provider failure -> bounded same-model reconnect -> typed progress/failure ->
   App retry or terminal state.

Conflict resolution must follow these paths. A passing isolated helper test does
not justify dropping behavior from a public path.

## Success criteria

- SC01: all 18 local commits and all commits reachable from the latest
  `origin/main` remain ancestors of the integration tip.
- SC02: conflict resolutions preserve the local Turn/Work, App activity,
  multimodal, reconnect, and artifact-delivery contracts.
- SC03: conflict resolutions preserve the upstream memory, recovery, cursor,
  workspace, quota, and GLM-5.3 contracts.
- SC04: focused tests cover every conflicted product responsibility, followed by
  typecheck, lint, architecture shape, repository check, and diff validation.
- SC05: the final PR explains the product flows, conflict decisions, validation
  evidence, and any residual risk without requiring reviewers to reconstruct the
  18-commit history.

## Non-goals and safety

- Do not rewrite or squash the 18 historical commits during integration.
- Do not reset or advance the local `main` ref.
- Do not modify live Butler data or restart production services for Git
  integration.
- Do not introduce fallback paths, duplicate state authorities, or compatibility
  behavior that weakens typed failure and cursor contracts.

## Execution tasks

1. Preserve the original tip on a pushed branch and isolated worktree.
2. Merge the latest `origin/main` and resolve conflicts by product authority.
3. Trace and review each affected canonical path.
4. Run focused and repository-wide validation.
5. Commit, push, and open the integration PR.
