# Butler Session UX Polish Specification

Status: accepted for implementation on 2026-08-04

## Intent lock

- Accepted intent: make the current session facts visible in real time, make
  scratch-project creation name-first, keep long sidebar session lists usable,
  and support file drag-and-drop with image previews.
- Approved revision: the 2026-08-04 user request plus the explicit constraints
  that production implementation uses Luna workers, review uses Sol high, and
  all UI is built from Butler Design System components and tokens.
- Observable success: the active session's summary and context stay current in
  the inspector and composer; scratch projects use a user-entered project/folder
  name; sidebar lists expand five rows at a time; dropped files are uploaded and
  image attachments show a thumbnail that keeps priority over file size.
- Canonical paths:
  - App Gateway live event -> session-view reconciliation -> Butler store
    summary -> inspector and composer selectors.
  - New-project action -> DS dialog -> `POST /projects` -> project folder store
    -> navigation refresh -> new project chat.
  - Navigation projection -> sidebar section/group -> five-row page expansion.
  - Composer drop target -> existing file upload path -> composer attachment
    state -> DS attachment list -> message attachment IDs on submit.
- Non-goals: transcript export redesign, a new event transport, pagination of
  the server navigation contract, arbitrary workspace deletion, or a parallel
  attachment/upload implementation.
- Forbidden substitutions: polling a different data source than session-view,
  displaying workspace status as a branch name, non-DS controls/styles, or
  tests that only assert source strings when behavior can be exercised.

## S1. Live summary and context

The active server-backed session follows the existing live event stream.
Successfully applied message, turn-state, turn-progress, worker, session-control,
and queue events whose payload identifies the active session schedule bounded
session-view reconciliation. While `SessionView.active_turn` is non-null, the
client also reconciles at most once per second so transcript-backed skill and
provider-context telemetry can become visible even when they do not emit a
dedicated App event. A leading refresh gives prompt feedback and a trailing
refresh captures the latest burst; only one refresh may be in flight and bursty
streaming must neither create an unbounded request rate nor postpone convergence
indefinitely. Reconnect and `stream.reconcile_required` continue to converge
through the same session-view endpoint.

`SessionView` is the single projection for progress, git branch, loaded skills,
context, artifacts, automations, and workers. Applying a refreshed view updates
the Butler store atomically. The inspector context panel and composer context
control both select the same current `summary.context_details` projection.

The Summary tab:

- shows the canonical current semantic projection from safe progress rows: up
  to eight ordered Ledger todos when present, otherwise up to eight current work
  blocks, otherwise the latest model-authored app-visible activity. Raw tool
  payloads, repetitive lifecycle rows, and model-wait rows stay hidden;
- labels git information as `Git branch` and shows only `branch_name` when
  `workspace_mode` is `git`;
- shows an explicit non-git/unavailable value for other workspace modes and
  never presents `Project workspace`, `Git workspace`, or another safe status
  as though it were a branch name;
- renders a git worktree with no symbolic branch as `Detached HEAD`, distinct
  from non-git folders, missing Git, and unavailable workspaces;
- shows skill names reported for the latest/current turn, refreshing during an
  active turn and after terminal delivery;
- removes the transcript export section and its now-unused Butler store action.
  The server export endpoint and bridge remain outside this change.

Loading, reconnect, failed refresh, cancellation, and session switching retain
the last coherent view for that session until a newer complete view arrives.
Responses for a no-longer-active session must not overwrite the active view.
No raw transcript, prompt, tool payload, hidden reasoning, or private path is
exposed.

Acceptance:

1. A relevant live event causes a bounded session-view refresh before terminal
   delivery and an updated context value appears in both inspector and composer.
2. A refreshed session-view with skills updates the Skills panel.
3. Git, folder, no-project, detached-HEAD, and unavailable states render
   truthfully; only a real branch name occupies the branch value.
4. Transcript export is absent from the Summary tab.
5. Session changes and stale asynchronous responses cannot cross-contaminate
   summary/context.

## S2. Named scratch projects and folders

Selecting `Start from scratch` opens a DS dialog before mutation. It contains a
focused project-name field, Cancel, and Create. Empty/whitespace-only names are
disabled. Escape/outside close and Cancel create nothing. Submission is pending
until the server responds and duplicate submission is prevented.

`POST /projects` with `source: "scratch"` requires a trimmed `display_name`.
The server validates it as one portable directory component of at most 80
Unicode code points: no `/` or `\\`, ASCII control character, Windows-invalid
`< > : \" | ? *`, `.`/`..`, trailing dot/space, or case-insensitive Windows
reserved stem (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`).
The project folder store creates the folder only beneath the configured project
workspace root. On collision, folders are tried as `Name`, `Name 2`, `Name 3`,
and so on while the project display name remains `Name`. Folder creation remains
recoverable at the current database boundary: if database creation fails after
a newly-created empty folder, the store removes only that exact empty folder;
it never deletes a pre-existing or non-empty directory. Existing-folder project
creation is unchanged and still requires the signed selection token. This
change does not introduce a new idempotency-key contract.

Acceptance:

1. Cancel creates no folder, database row, event, or navigation item.
2. `Alpha` creates a project displayed as `Alpha` and a workspace folder named
   `Alpha` (or the documented collision suffix).
3. Empty, traversal, separator, reserved, and unsafe names fail closed with a
   public error and create no out-of-root folder.
4. UI tests cover dialog validation/pending/cancel, and server tests cover folder
   naming, collision, safety, and existing-folder compatibility.

## S3. Sidebar session paging

Each independent sidebar session list starts with at most five rows: the Chats
section and every expanded project group. When more rows exist, a DS button
shows the remaining count. Each activation reveals the next five rows in the
existing server order. The control disappears when all rows are visible.
Collapsing a section does not change its data; navigating or live navigation
refreshes do not hide an active session that is already visible. New component
instances reset to five. No server-side pagination or row reordering is added.

Acceptance:

1. Lists of 0-5 rows have no more button; 6 rows show 5 then 1; 12 rows show
   5, then 10, then 12.
2. Chats and two project groups keep independent visible counts.
3. Existing session row actions, active state, and ordering remain unchanged.

## S4. Composer file drop and image previews

The existing Composer card is the drop target. File drags receive immediate DS
visual feedback; non-file drags are ignored. Dropping one or more files prevents
browser navigation and calls the existing `addFiles` upload path exactly once
with the dropped `FileList`. The file picker remains available. Upload size
limits, error notices, session switching, and submitted attachment IDs continue
to use the existing attachment workflow.

The DS `AttachmentList` supports an optional image thumbnail. Composer image
items supply the existing safe local file URL as that thumbnail; non-images keep
their DS icon. Thumbnail rendering has an accessible label, bounded dimensions,
and safe fallback styling. Attachment layout priority is thumbnail/icon first,
file name second, remove action third, and file-size metadata last. At narrow
container widths the metadata hides before the thumbnail or name truncates.
Object URLs are not introduced, so no new URL lifecycle or durable state is
required.

Acceptance:

1. Drag enter/leave/drop behavior is covered with real React events, including
   ignored non-file drags and one upload call per drop.
2. Image attachments render a DS thumbnail and name; ordinary files render the
   existing icon and name.
3. DS fixture/render coverage includes image, ordinary file, narrow layout,
   hover/focus, and removable states.
4. File-size metadata is the first optional visual detail removed under space
   pressure.

## Validation and delivery

Task slices are reviewed against this specification after their targeted tests.
The final gate is targeted UI/server tests, `bun run lint`, `bun run typecheck`,
`git diff --check`, and `bun run check`. Component implementations remain at or
under 160 lines; domain wrappers use focused Zustand selectors; reusable visual
behavior lives in DS blocks with fixture, README, CSS module, and index export.
Each completed phase is committed, and the final report records criteria,
tests, residual risk, and commit hashes.
