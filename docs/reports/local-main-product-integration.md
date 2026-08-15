# Local main product integration

Status: Integration specification approved for execution on 2026-08-16.

## Accepted intent

Preserve the mergeable product behavior developed in the 18 commits directly on
local `main` after `549463fb`, integrate it with the latest `origin/main`, and
publish the result as a reviewable pull request. The local `main` ref must remain
at `dd19567b` until a later explicit decision. Historical commits remain in the
branch ancestry, while retired or private one-off operational material may be
removed from the resulting product tree during integration review.

The integration must preserve both lines of product behavior:

- local line: explicit Turn/Work relations and disposition, live App
  reconciliation, multimodal image carriers, provider reconnect status, and
  generated/workspace artifact delivery;
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
  `origin/main` remain ancestors of the integration tip; integration review may
  remove retired behavior from the final tree with an explicit decision record.
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

## Integration decisions

- The latest `origin/main` provider catalog and quota path remain authoritative;
  the local Z.AI image capability metadata is retained only for the exact GLM-5.2
  MCP vision route, while GLM-5.3 remains available through the upstream catalog.
- Workspace authorization and session-owned worktrees use the upstream binding
  authority. The local image-analysis tool is added conditionally without
  widening the ordinary workspace tool surface.
- Explicit `start_work`/`continue_work` relation and
  `record_work_disposition` closeout remain authoritative. The upstream native
  workspace lifecycle regression was updated to exercise that public contract
  instead of relying on implicit Work selection or review-as-completion.
- The Sandy-specific correction command, its one-off implementation, its tests,
  and its live-data report are excluded from the final tree. The canonical CLI
  reference marks that command retired, the live correction is already complete,
  and the report contains operational identifiers and local paths that must not
  enter a portable pull request. Generic Turn/Work integrity fixes remain.
- Merge-grown orchestration files were reduced by extracting cohesive contracts,
  initial Work hydration, executor contracts, and provider-failure presentation;
  the BTCC shape gate passes without raising thresholds.

## Validation evidence

- Conflicted-path focused suites: 382 tests passed after conflict resolution;
  extracted guided/runtime paths added another 108 passing tests.
- Native workspace public-path regression: 2 tests passed after adopting the
  explicit Work relation/disposition contract.
- Butler tool surface: 133 tests passed with the existing 33,000-byte cap; no cap
  was raised.
- Full TypeScript typecheck passed.
- Full ESLint passed with zero errors and 24 pre-existing warnings.
- BTCC source-shape validation passed for 4 domains and 229 files.
- The first hosted Windows run exposed the newly enforced
  `GHSA-jmr9-qjv8-65gv` audit on `extract-zip`. Electron Packager was advanced
  from 20.0.0 to 20.3.0, which replaces that unpatched dependency with
  `@electron-internal/extract-zip`; clean `npm ci`, high-severity audit, Windows
  workflow tests, and focused Windows release-packaging tests then passed.
- Repository `check` reached 2,745 passes. Its remaining failures were classified
  against the byte-identical latest `origin/main` tree: five App projection tests,
  the native purge gate, and two Electron harness tests reproduce upstream. The
  CLI documentation mismatch and native workspace explicit-Work regression were
  integration-owned and were fixed.

## Residual baseline

The integration does not claim to repair unrelated latest-main failures. The
following remain visible for follow-up rather than being hidden or weakened:

- five App projection/cancel-history assertions;
- the generic OpenAI raw-token native purge gate;
- two Electron harness bridge/Stop fixtures.

These failures reproduce on the byte-identical `origin/main` tree and are not
introduced by this integration. Focused tests for every changed canonical path,
typecheck, lint, shape validation, and diff validation remain required before the
merge commit is published.
