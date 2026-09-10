# #26 sidebar / space interaction mockup

Status: visual/interaction mockup approved on 2026-09-07; not product implementation.

## Current authority

The consolidated specification is Butler Project Ledger
`specs/ui-sidebar-information-architecture.md` (2026-09-07), with implementation
plan `PLAN-UI-SIDEBAR-26-20260907`. It supersedes the chronological design notes
below. Accepted screenshots are preserved in Ledger `references/sidebar-26/`.
Historical sizes and interaction proposals below are not additional requirements.
The final scale is desktop 16px / mobile 20px with the shared mobile optical
correction. Production persistence, relocation, inline references and model-based
smart grouping remain implementation work; this mockup still resets on reload.

## Intent

Use actual Butler DS components to review a persistent #일반 channel, pinned
conversation shortcuts, a mixed group/project/session space, smart grouping,
conversation references, and branching a message into a topic/project.

## Scope and tasks

### Mobile optical alignment correction

Apply one shared mobile icon offset of -0.03 times the mobile navigation font
size (17px gives -0.51px), based on the measured 0.55px visual-center mismatch.
Keep desktop at zero. Translate the SVG artwork only: do not move hit targets,
change row layout, or overwrite the spinner rotation transform. Check the
computed offset and rendered screen before closing this correction.

### Responsive icon scale — current approved revision

One sidebar icon scale: desktop 16px, mobile (up to 640px) 20px. Apply it to
primary navigation, General, entity rows, tabs, status, row controls, theme and
settings, including favorites dialog rows. Preserve the 1.5 stroke, typography,
44px mobile hit targets, long-press menus and spacing. Remove competing local
status sizes. Verify actual computed widths on both viewports and capture both.
Complete: checked all 50 sidebar SVGs at desktop/mobile (16×16 / 20×20),
including hidden menu/favorite variants. 320px tabs do not overflow. UI typecheck,
scoped ESLint/Stylelint and whitespace checks passed. Captures:
/tmp/butler-sidebar-responsive-desktop.png and
/tmp/butler-sidebar-responsive-mobile.png. No production rollout.

### Mobile hierarchy and long-press refinement

Mobile only: enlarge Butler title from 17px to the DS 26px title scale; increase
the three major section gaps from 16px to 24px, and the browse-heading gap to
16px. Keep desktop sizing and row density unchanged. Hide row more buttons on
mobile; retain existing 500ms long press and normal status indicators. Check
mobile layout and actual long-press menu opening in the mockup.
Verified 390px: 26px title, 24px section gaps, all row more buttons hidden.
Synthetic touch pointer hold exercises the existing hook and opens the menu.
Desktop remains 15px title / 24px section gaps. UI types and scoped style checks
pass. Screenshot: /tmp/butler-sidebar-mobile-hierarchy.png.

### Settings entry and screenshots

Add the existing-style Settings navigation row to SidebarShell's fixed footer,
below the optional undo action. Reuse DS NavRow/Settings/Dialog; clicking explains
that this is a mockup, without opening or changing production settings. Preserve
the agreed navigation styling. Verify footer visibility on desktop and mobile and
capture both rendered screens for design review.
Footer separation uses spacing only, preserving the no-divider agreement.
Verified: settings stays at the viewport bottom when the tree scrolls; the mobile
row is 44px tall. Desktop 1440×1000 and mobile 390×844 screenshots captured.
UI typecheck and scoped ESLint passed; only mockup settings guidance opens.

### Selection tone refinement

Reduce only the selected navigation row background to 75% of the current DS
selection tone. Preserve text, icons, hover and tab styles. Verify light/dark
computed colors in the existing mockup; no production rollout.

### Current sizing amendment — 2026-09-07

Use 16×16 identity icons for sessions, groups and projects, including the favorite
hover replacement. Keep the default 1.5 stroke, status/menu slot and all layout
unchanged. Apply the existing 16px DS space token, then check rendered dimensions.

### Current correction — 2026-09-07 16:30

This user revision supersedes the enlarged icons and status placement below.
1. Restore the previous session icon's 15px / default 1.5 stroke, and match group
   and project identity icons to it. Remove the newly added sidebar background;
   retain existing active/hover treatments and the existing page surface.
2. Put session status in the exact more-menu slot, not beside the title. Reveal
   more instead on row hover, keyboard focus or an open menu. Touching that same
   slot opens the existing menu; touch users do not require a hover gesture.
3. Recent and Running use one metadata rule: location left, secondary fact right
   (relative age in Recent, status/progress in Running). Preserve all other mock
   interactions, hit targets, and layout. No production rollout or commit.
4. Check actual desktop/mobile idle/hover/menu states, both lists, light/dark,
   computed icon geometry, type/style checks and existing focused tests.

Completed: all entity identity SVGs measure 15px with the original 1.5 stroke.
Status and menu share a single hit area; browser checks confirmed identical
centers, hover/focus swaps, keyboard activation, and direct menu opening at 390px.
Both metadata layouts retain location left; a rendered-component regression test
covers the ordering and confirms status is absent from the label region.
No sidebar fill is applied. The existing page theme is opaque at the canvas and
sticky headers reuse that same color, avoiding cumulative translucent dark blocks.
Checked desktop and 320/375/390/430px layouts, light/dark. Eight focused tests (39
assertions), UI types, scoped lint/style and design lint pass. Module audit: 27
sources, no findings. This remains an in-memory mockup without a runtime rollout.

### Approved visual consolidation — 2026-09-07

Intent: address the seven observed audit issues together with matching perceived
sizes for session/group/project icons. Entry remains sidebar-mockup.html; in-memory
mock state is the only authority. No production rollout, data changes, new agents,
or replacement navigation framework.

1. Complete: consolidate row visuals — one 20px identity-icon box, consistent stroke,
   shared slot for favorite and ordinary icons; 16px DS `Spinner`; separate
   attention tone. Two-line maximum title, aligned title/status and location/time.
2. Complete: quiet controls — desktop hover/focus reveal, always accessible touch menu,
   no shrinking buttons; project new-chat remains in menu, collapse uses row/header.
   Preserve contextual menus, favorite toggling, drag/drop and shallow indentation.
3. Complete: bound fixed chrome — two favorite shortcuts plus an all-favorites dialog;
   mobile primary actions share a row, with compact spacing. Only the main tree
   below its heading scrolls. Favorites dialog provides the full list without
   consuming the tree viewport. Same opaque sidebar surface for sticky headers.
4. Complete: actual browser 320/375/390/430px and desktop, light/dark; six favorites, long
   title, status, group/project/session icon dimensions and ink bounds, touch
   targets, hover/focus, existing DnD regression; focused tests/types/style checks.

Acceptance: icons no longer differ because some pass through an IconButton;
mobile controls keep 44px hit areas; favorites growth cannot shrink the tree;
long titles cannot grow without bound; time/status share row alignment; waiting
and attention have readable meaning; dark sticky headers merge with the sidebar.
Keep equal-width tabs, four-pixel heading inset, eight-pixel tree indentation,
flat subdued selection, and existing sample actions. No divider added.

Review evidence: Clickable's nested icon-button rule previously reduced session
icons to 15px while folder/project icons followed the larger row size. Optional
Clickable action-size/icon-size tokens now preserve its existing defaults and
allow this sidebar to declare one 20px identity slot with 1.75 stroke. Browser
measurements confirm all four entity types use 20px SVG boxes; their path maximum
extent is 19–20 viewBox units. Favorite icon hit areas no longer clamp to that
20px slot: mobile favorite/menu/collapse controls are 44px. Desktop menus reveal
only in their own hovered/focused row, without shifting the label.

Six favorites retain two shortcuts; the full dialog lists all six and selection
closes it. Long-title browser case stayed at exactly two lines (51px at 390px),
with metadata below. Working state uses a 16px open arc and visible progress in
Running; attention uses a static alert and readable primary text, not pale amber
text. Dark sticky headers share the sidebar's opaque surface. Browser checks at
320/375/390/430px and 1360px found no page-width overflow. Chromium responsive
verification is not a claim of physical iOS/Android testing.

Focused checks: UI TypeScript; seven DnD/relative-time tests (31 assertions);
scoped ESLint/Stylelint; repository design lint; git diff whitespace check passed.
Module audit: 36 sources; only pre-existing Clickable/index.ts wildcard export was
flagged, unchanged in this slice. No production build/restart/commit or data write.
Screenshots: /tmp/sidebar-polish-final-recent.png,
/tmp/sidebar-polish-dark-all.png, /tmp/sidebar-polish-320-long.png,
/tmp/sidebar-polish-favorites-dialog.png. Preview remains port 25176.

1. Compose the sidebar and conversation using existing DS shells and controls.
2. Wire in-memory sample interactions: views, groups, search, move, reference,
   smart-group example, and message-based topic/project creation.
3. Review desktop/mobile and light/dark rendering; check UI types and CSS.

Current refinement: three visual blocks (primary actions, favorites, browsing).
Current row parity tasks: draw DnD indicators above sticky headers at the actual
hovered header geometry (straight edge lines; central outline only for nesting).
Recent rows show relative activity time, and working sessions show a spinner,
distinct from attention-needed. Restore session rename/archive and contextual
menus; project new chat/dashboard/pin/rename/archive/delete. All actions affect
sample records only, with undo for removal and confirmation for project deletion.
Show first five children per group with an explicit load-more control. Use the
same row menus in favorites; mobile must retain access to menus.
Completed row parity review: reused DS OverflowActionMenu and the existing
long-press hook; rename/archive work for sessions, with project dashboard preview,
new chat, favorite, rename/archive/delete. Project deletion has a confirmation;
all removals can be undone inside the sidebar, including on mobile. The dashboard
is an explicitly labeled sample preview, not a connection to the real Ledger.
Recent rows are sorted by last activity, display relative age, and expose an
absolute timestamp on hover. New/sent sample conversations update their timestamp.
Working status uses the official DS `Spinner`; attention uses a static
alert icon. Reduced-motion preferences disable rotation.
Verified straight before/after markers over expanded headers (2px, radius zero,
above sticky stacking), plus instance-isolation/header-geometry regression tests.
Browser checks passed for 390/320px menus/relative ages, light/dark themes,
long-press and context menus, rename, dashboard, new project chat, project favorite,
archive/undo, confirmed project removal/undo, and five-item pagination.
Focused tests: 7 passing; UI typecheck, scoped ESLint/Stylelint, design lint pass.
Selection uses the regular DS selection tone instead of the strong tone within
this sidebar only; typography and layout remain unchanged in light/dark themes.
Scrolling contract: primary actions, favorites, tabs, General and the current
list heading/actions stay fixed. Only the rows below Space/Recent/Running scroll.
Expanded group/project headers stick within their own branch; nested parents
stack by one row height and leave when their branch ends. Use native CSS sticky,
not duplicated rows or scroll-driven state. Existing DS consumers stay unchanged.
Verified in the browser: list scrolling leaves the section heading fixed;
nested Product/Project headers stack at 0/one-row offsets in a longer temporary
fixture, and mobile Recent scrolls independently. The temporary rows are not
part of the saved sample data.
Use 24px between blocks, 8px within sections and 12px between tabs and general.
Hover/focus the session icon to toggle a star without opening the conversation.
Drag sessions/groups: edge = reorder, folder center = move inside, root target =
move out. Highlight the exact destination, preserve descendants and offer undo.
Session on session: center = create a group at the target's existing position,
containing target then dragged session; edges still reorder. Show "그룹으로 묶기"
before drop. Create "새 그룹", expand it, and offer naming (optional) and undo.
Grouping does not transfer project ownership: both sessions must belong to the
same project, or both be non-project conversations. Favorites remain source-only.
Verified native session-on-session drop, naming, child placement and undo in the
browser; targeted tests cover grouping, unchanged neighbors, project ownership
and the existing duplicate-shortcut drag-marker regression.
Dragging a session onto the composer still adds a reference, never moves it.
This is desktop mouse DnD preview; touch reordering is not claimed.
Current follow-up: section headings have a 4px optical inset from the rounded
tab boundary. Recent/Running section headings have 16px clearance below tabs
(8px more than All's content boundary). Multi-line rows
have vertical padding and first-line-aligned icons. Sidebar text is not selectable.
General is fixed only in All, not above Recent/Running. Session references are
blue DS-colored inline icon/title mentions inserted at the saved text caret,
not attachments. Preserve surrounding text and multiple references when sending.
Tasks: adjust navigation spacing/filtering, implement the inline draft editor,
then exercise caret insertion, send and desktop/mobile layouts in the preview.
Verified: native drag inserts in the middle of existing text; two mentions stay
inline after send; Backspace removes a mention without removing adjacent text.
Desktop and 390/320px rows retain padding and first-line icon alignment. Filtered
views omit the fixed General row; computed sidebar text selection is disabled.
Drag indicators belong to one rendered row instance, not to the session ID:
favorites and tree rows may reference the same session without sharing markers.
Only enabled tree rows accept moves; favorites are source-only shortcuts.
The sidebar owns the close button when open. When closed, the conversation uses
the DS floating toggle at the leading edge, with titlebar space reserved for it.
Verified the duplicate-session marker regression with rendered components and
the browser: one tree target marker, none on favorites, and clearing when entering
favorites. Desktop/mobile closed-sidebar titlebar placement was visually checked.
Reference: https://www.notion.com/help/navigate-with-the-sidebar — separate quick
access from content hierarchy; direct drag-and-drop organization. This mockup
uses Butler DS rather than reproducing Notion's visual tokens.

Browser checks: icon hover and favorite toggle preserve the current conversation;
session into group, group into group with descendants, and composer reference
drop succeeded. Three pure tree-move tests cover placement and structure.

The standalone `sidebar-mockup.html` entry never imports the App store, IPC,
runtime APIs or production bootstrap. No persistence, model calls, real project
creation, filesystem moves, or production restart. Reload resets the prototype.

## Proposed behavior being illustrated

- #일반 stays outside the space and all smart grouping; scheduled output includes
  its source label. Original messages remain when a topic branches off.
- Pins are shortcuts. All/recent/running views affect the space only.
- General conversations use a speech-bubble icon; project conversations use a
  note icon, including pinned and filtered views. Membership follows project
  ancestry, not whether the conversation is directly inside a group.
- Smart grouping starts enabled. The example matches travel-related sample
  requests after send, reusing/creating 여행; it is deterministic, NOT an AI model.
- Root sample 京都/교토 conversation + a new travel conversation form two members.
- Message actions preview the relevant request, decision, remaining question,
  and original conversation reference before creating a sample topic/project.
- Drag a conversation onto the composer or use its reference action. Session
  moving is a different action with its own destination chooser.

## Open design decisions

- Approved follow-up: use equal-width outlined DS tabs labeled 전체보기 / 최신 /
  진행중 with icons. Separate sidebar sections with spacing, not divider lines.
- Current layout refinement: block spacing 24px; title-to-items 8px;
  brand-to-primary-navigation 4px; row gaps use the DS 2/4px density.
  Favorite conversations have a section title. Tabs fill available width in
  three equal tracks, inside one outline, with icons. Child groups use the DS
  opt-in indented presentation (8px per depth in this mockup); existing consumers stay unchanged.
- Branch action visibility and how much source context is editable before start.
- Scope of automatic grouping into user-created groups; correction behavior.
- Move behavior for active executions and project-owned files (not simulated).

## Run

From `packages/butler-app/client/ui`:
`bun run dev --port 25176 --strictPort`

Open `http://127.0.0.1:25176/sidebar-mockup.html`.
Use `?theme=dark` for dark screenshots. A theme toggle is also in the sidebar.
Try 새 대화 then send `오사카 여행을 계획해줘` to see the sample smart grouping.

This prototype does not mark GitHub #26 or its Ledger tasks complete.

## Review completed

- UI typecheck, design lint, changed-file ESLint and CSS Stylelint passed.
- Browser preview checked at 1360px desktop and 390px mobile, light and dark.
- Exercised topic creation and source return, smart-group creation and undo,
  reference picker and actual drag/drop, running filter and move picker.
- DS now has opt-in equal-width tabs and indented groups; existing consumers
  retain their defaults. The mockup shows the approved tree hierarchy.

Follow-up: adopted DS Tabs, added public
speech-bubble/note icon mappings, and checked desktop/320px tab switching.
UI types, design lint and changed CSS lint passed. The broad design-foundation
test returned 38 pass / 7 fail; those wider assertions remain unresolved and are
not acceptance claims for this mockup. No production rollout was performed.

Layout refinement verified: desktop and 320px screenshots, three equal tab
widths without overflow, and child offsets of 16px per depth. UI typecheck,
design lint and changed CSS lint passed. No operating process was restarted.
