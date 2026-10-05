# Task graph: implementation spec

Status: owner-approved design (rounds 1–4, 2026-10-05/06; multi-graph variant A chosen). Implementation by Codex.
Design proposal: branch `design/task-graph`, DS site route `?proposal=task-graph`
(`packages/butler-app/client/ui/ds-site/proposals/task-graph/`). The proposal's fixtures, layout code and copy
are the reference; move them into product code as described here.
Model: `plans/work-model/work-model-design.md` on `origin/codex/work-model-design` (§2.2 records, §2.5 graph
is read-only, §5 UI read model and events).

## 1. What the user gets

- A new inspector tab **작업 / Tasks**, right after **요약 / Summary**. The Summary tab is unchanged.
- The tab is titled **작업 그래프 / Task graph**. Never show "위임", "delegated", "Work", "Steward",
  tool ids or raw error codes.
- Each graph is the task DAG of one plan. One conversation can have several graphs at the same time.
- Read-only: no drag, no editing, no reorder. The only actions are selecting, opening the worker's
  conversation and opening the task document.
- The inspector stays resizable by its edge (already in the product, see §6).

## 2. Layout

### 2.1 One graph

- **Desktop / tablet (> 640px):** ranks left to right inside `ScrollArea orientation="x"`, which runs from
  edge to edge under the tab header. Cards are 208px wide. Columns are 40px apart (`Stack gap="2xl"` plus
  `Box paddingStart="lg"`) and cards in a column are 12px apart (`gap="md"`). Columns are vertically
  centred. The edge fades follow the scroll position (ScrollArea's built-in `data-at-start`/`data-at-end`).
- **Phone (≤ 640px):** the same graph top to bottom, using `InspectorInset`. A lane gutter on the left
  shows fan-out and join (lane pitch 14px, dot on the card's first text line). Cards fill the rest of the
  width. Rows are in topological order.
- **Layout code:** `layout.ts` from the proposal, kept as-is. It is pure and O(V+E).
  - Rank is the longest path from a source.
  - Column order is the barycentre of each task's predecessors.
  - Phone lanes are git-log style lanes.
  - The cycle guard must stay. Edges that skip ranks are not routed yet; Codex adds dummy nodes when real
    data needs it.
- **Edges** are SVG drawn inside the canvas, using tokens only and no motion:
  - solid `--line-strong` once the prerequisite is completed;
  - dashed when it is still waiting;
  - dashed `--danger` from a failed or cancelled task;
  - 2px `--worker-active` into a running task.

### 2.2 Several graphs: variant A, stacked sections (chosen)

The owner chose variant A in round 4.

- **Row component:** under the header, each graph gets one `DisclosureRow` with the **default
  `surface="selection"`**, rendered **without children**. Do not use `surface="plain"` here.
  - `title` = the plan's goal;
  - `icon` = the graph's state glyph (`statusIcon`);
  - `meta` = its counts.
- **Required DisclosureRow version:** the current DS block, which includes `e8be31c66` "fix(ds): preserve
  disclosure titles beside long metadata" (on `origin/main` and `batch/preview-10`). No newer
  DisclosureRow change exists on any branch. With it:
  - the trigger keeps its `--disclosure-inset` (8px) inside the row box;
  - chevron, icon, title and meta share the first-line box, so the glyph is centred on the title line;
  - hover fills the row box, and an open row keeps the flat `--selection` fill;
  - long meta wraps within half the row, so the title is never pushed out.
- **The graph renders below the row, outside its panel.** Passing it as children would indent the cards to
  the panel's title column (inset + 2 × (line + sm) ≈ 64px), and the fill would cover the whole canvas.
- **One inset:** the row box, the header, the first card column and the detail panel all start at the
  inspector inline padding (18px).
  - The canvas reaches 18px through ScrollArea's 14px edge padding plus `Box paddingX="xs"`.
  - When the selected card is off-screen, the canvas scrolls so that card's column starts at 18px. It does
    not centre the card.
- **Spacing:**
  - header to first row: the Section's own header-to-content gap (lg, 16px); the outer stack uses gap
    `none`;
  - folded rows: 4px apart (the DS row rhythm);
  - an open graph: `Box paddingY="sm"` (8px) above and below its canvas;
  - canvas to detail: gap md.
- **Row heights:** 36px on desktop, 39px at 375 (the DS body line plus the 8px inset).
- **Open by default:** running and failed graphs. Finished and cancelled graphs are folded to one line. If
  no graph is running or failed, the first graph is open.
- **Order:** running, failed, waiting, done, cancelled. Order is stable within each state. Graph state
  rolls up from the task states (`graphs.ts`).
- The task detail opens directly under the graph that owns the selected task.
- With exactly one graph, the row is hidden, the plan goal becomes the header's `description`, and the
  header shows that graph's counts. With several graphs, the header shows "그래프 N개 · 진행 중 M" /
  "N graphs · M running".
- The user's open/fold choice is kept in memory for the conversation only and is never written to disk.
- **Phone lanes:** each lane dot is centred on the card's status glyph, which is measured. This keeps the
  dot on the card's first text line at the phone type scale.
- **Not chosen:**
  - B, a graph picker (`Select`): it hides other graphs' failures behind a menu.
  - C, one combined canvas: it leaves empty bands, and the band labels scroll away with the canvas.

## 3. Card (DS primitives only)

The card is `Card interactive padding="sm" selected aria-pressed aria-haspopup="dialog"` (the `aria-haspopup`
only when the task is assigned), with `data-task-id` and `data-test-class="task-graph-card"`. Inside:

1. `IconSlot size="md" minHeight="line"` holding the status glyph:
   - `LoadingIndicator` loading → done, which draws the check;
   - `Eye` for in review;
   - `CircleAlert` in danger tone for failed, warning tone for blocked;
   - `CircleX` for cancelled, `Minus` for paused, `Circle` for pending.

   Next to it, the title as `Typo.Body lineClamp={2}`, with the full title in `title`.
2. `Typo.Caption` tertiary, truncated: "작업자 N · <model display name>", or "배정 전" when unassigned.
3. `Tag size="sm"` with the status (accent for running and in review, danger for failed, warning for
   blocked, neutral otherwise), then the elapsed time as `Typo.Caption numeric="tabular"`.
4. Running tasks only: the current step in `RollingStatusLine aria-live="polite"` + `RollingSwap`.

Do **not** use WorkerActivityPanel, WorkerActivityRow, WorkActivityBlock or WorkerCallCapsule; they no longer
fit the turn engine.

**Interaction**
- Click, Enter or Space selects the card and, if the task has a `session_id`, calls
  `openSessionObserver(session_id)`.
- Arrow keys only move focus and selection:
  - desktop: Right/Left follow edges, Up/Down stay in the column;
  - phone: Up/Down follow rows.
- The selected card is scrolled into view horizontally; the page itself does not scroll.
- Default selection: the first running task in the ordered graphs, else the first failed, else blocked,
  else the last finished task.

## 4. Detail (selected task)

`InspectorPanel` with `title` = the task title and `action` = the status `Tag`. Inside:

- `Notice tone="error"` with the failure reason, or `tone="warning"` "앞선 작업이 실패했습니다" when blocked.
  Short copy only.
- `KeyValueRow` rows:
  - 담당 (assignee);
  - 모델 (model);
  - 걸린 시간 (elapsed);
  - 지금 하는 일 (current step, running only);
  - 앞선 작업 / 다음 작업 (before / next), as `Clickable variant="text"` links that only move the selection.
- `DocumentTile` "작업 문서": `meta` = `TASK-… · status`, `clickTarget="tile"`. Opening it shows the real
  `ProjectDocumentDialog` (`DocumentReader`) with the task document.
- `Button size="sm" variant="outline"` "대화 보기", which opens the same conversation dialog as the card.

## 5. Linked surfaces (reused unchanged)

- **Conversation:** `SessionObserverDialog`, through `useButlerStore().openSessionObserver(sessionId)`.
  Its existing stop and resume controls stay as they are; the graph itself never edits anything.
- **Task document:** `ProjectDocumentDialog` with a `ProjectDashboardDocument`:
  - `kind: "plan"`, `document_type: "task"`;
  - the body carries the goal, the done criteria and the prerequisites;
  - frontmatter: `id`, `status`, `parent` (the pinned spec node), `owner`.

## 6. Inspector resizing (exists; no DS gap)

- The drag and keyboard behaviour already exist: `AdaptiveShell`, `AdaptivePanelResizeHandle side="right"`
  and `hooks/usePanelResize.ts`.
- Limits come from `app/panelSizing.ts`:
  - min 292px;
  - max = window − sidebar − 320px workspace;
  - default 376px;
  - arrows ±16px, Home/End.
- The width is persisted through `useAppBootstrap` → `writeCachedAppUiState({ right_panel_width })`.
- Nothing to build. The E2E check in §11 covers it.

## 7. Copy (i18n keys)

- Add `taskGraph` to `packages/butler-i18n/src/locales/{ko,en}.ts` and to the `AppCopy` contract. Take the
  content from the proposal's `copy.ts` (`TASK_GRAPH_COPY`).
- Add `inspector.tabs.tasks` = "작업" / "Tasks".
- Key texts (KO / EN):

| Key | KO | EN |
|---|---|---|
| title | 작업 그래프 | Task graph |
| empty | 아직 작업이 없습니다 | No tasks yet |
| doneCount | 3/6 완료 | 3/6 done |
| graphsSummary | 그래프 6개 · 진행 중 2 | 6 graphs · 2 running |
| status.pending | 대기 | Waiting |
| status.running | 진행 중 | Running |
| status.awaiting_review | 검토 중 | In review |
| status.completed | 완료 | Done |
| status.failed | 실패 | Failed |
| status.cancelled | 취소됨 | Cancelled |
| status.blocked | 보류 | Blocked |
| status.paused | 일시정지 | Paused |
| assignee | 작업자 N | Worker N |
| detail.document | 작업 문서 | Task document |
| detail.conversation | 대화 보기 | View conversation |
| elapsed | 3분 12초 / 1시간 4분 | 3m 12s / 1h 4m |

- Fix existing copy along the way:
  - ko `interfaceStatus.task` is "Task" and shows as the document dialog badge. It must be "작업".
  - `projectDocumentBadgeLabel` falls back to `interfaceStatus.work` ("Work"). Make the fallback a neutral
    "문서" / "Document".

## 8. Backend needs

What exists today:
- `btcc_subsession_delegations` stores each delegation's parent, child, ordinal and created time.
- The worker packet stores `plan_action.dependency_keys`, `model_ref` and `reasoning_effort`.
- The App projection (`subsessions/service/projection.rs`, `gateway/application/monitoring.rs`) exposes no
  edges, model, start or finish time, or document, and its `updated_at` is the creation time.
- The only live signal is `subsession.changed`.

Add:

1. `GET /sessions/{id}/task-graphs?cursor=` lists the conversation's graphs:
   `[{graph_id (= plan_id), title (plan goal), state, counts:{total,completed,running,failed,blocked,cancelled}, graph_revision, updated_at}]`.
2. `GET /plans/{plan_id}/task-graph?revision=&cursor=` returns one graph:
   - `nodes`: `{task_id, title, status, kind, rank, assignee_ordinal?, model_display_name?, session_id?, started_at?, finished_at?, current_step?, blocked_reason?, document:{id, revision, title, status, source_label}}`;
   - `edges`: `{from, to}`;
   - plus `graph_revision`, `event_seq` and exact totals. Pages are keyset-based and bound to one revision.
3. `session_id` on each node is the worker's child session, so the existing conversation dialog opens it.
   It is null until the task is assigned.
4. `GET /tasks/{task_id}/document?revision=` returns the task export (goal, done criteria, prerequisites)
   and the pinned `spec_ref`, in the `ProjectDashboardDocument` shape.
   - `source_label` must be a user-facing label and must not contain "work".
5. Edge source: today, map `plan_action.dependency_keys` to task ids per plan revision; after the work
   model, use the `Dependency` table.
6. Live event: `work_model.changed{plan_id, graph_revision, entity_changes, counts, event_seq}` on
   `/events/live`.
   - The tab patches the changed nodes and refetches only on a revision gap.
   - `subsession.changed` stays the trigger for conversation views.
7. Tier 0 (no plan) returns an empty list, and the tab shows `EmptyLine`.

## 9. Product files

- `src/components/inspector/Inspector.tsx`: add the `tasks` tab after `summary`, with the `Blocks` icon.
  Do not change any other tab.
- New container `src/components/inspector/TasksPanel.tsx`. It selects from the store and maps to props.
  Presenters move from the proposal, each ≤ 160 lines:
  - `TaskGraphSection` → `TasksPanel`;
  - `MultiGraph` (`StackedGraphs`);
  - `GraphView`, `GraphCanvas`, `GraphLanes`, `TaskCard`, `TaskDetail`, `edges`.
- New `src/app/taskGraphLayout.ts` (from `layout.ts`) and `src/app/taskGraphs.ts` (from `graphs.ts`).
- Store: `taskGraphs[sessionId]` holds the list plus per-graph snapshots, fed by the endpoints and events
  in §8.
- `UNSAFE_style`: canvas width/height/transform and the zero-height SVG layer. Allowlist only these files.

## 10. Performance budget

- One 1s clock per tab, only while a task runs and the page is visible.
- Layout is computed once per graph revision. Card rects are re-measured only on resize (ResizeObserver).
- Collapsed graphs render no canvas.
- No polling. Zero disk writes from viewing, scrolling, collapsing or resizing (the width write already
  exists and is debounced by the app).
- No new dependencies. Canvas virtualization is allowed above 200 nodes and is rendering only: totals stay
  exact.

## 11. Verification

Use stub E2E with isolated data. Do not add UI unit tests or pixel sampling.

- The Tasks tab exists after Summary, and the Summary tab still renders the progress panel and no graph.
- Fixtures cover 1 graph (empty, one, chain, fan-out + join, failed, cancelled, long 16) and 2 and 6
  graphs. Check `task-graph-card` and `path[data-edge]` counts, and `task-graph-group[data-open]` per
  graph state.
- A card click opens `steward-observer-dialog` with that child session, and a pending card does not.
  The DocumentTile opens the document dialog.
- Keyboard: arrow navigation; the canvas `data-at-start`/`data-at-end` attributes follow `scrollLeft`.
- Resize: drag the right handle and check min, max and keyboard steps; the width survives a reload.
- Text audit: no "Work", "Steward", "스튜어드", "위임" or tool ids in the tab or dialogs.
- Run `bun run app:layout:smoke` and `bun run app:design-system:smoke`, at 375 and 1280, light and dark.

## 12. Known DS gaps (do not patch the DS; propose separately)

- `Card` has no running emphasis. Proposed: `Card activity="running"` with a `--worker-active` hairline and
  a `--pulse-duration` ring that is static under reduced motion.
- `RollingSwap` (`components/RollingSwap/RollingSwap.tsx:67`) honours only the OS reduced-motion setting,
  not the `data-motion="reduced"` scope.
