# AdaptiveShell

## What it is

`AdaptiveShell` is the domain-neutral Butler application shell presenter. It
owns expanded grid layout and compact/medium transform-based navigation and
inspector panels without reducing compact workspace width.

## Use

Compose `AdaptiveShellSidebar`, `AdaptiveShellWorkspace`,
`AdaptiveShellInspector`, `AdaptiveShellScrim`, and `AdaptivePanelTitlebar` at
the App shell boundary. Product containers own route data and the mutually
exclusive open-panel state.

## Responsive behavior

- Expanded layouts use resizable grid tracks. Tracks never interpolate: the
  docked sidebar slides with a transform while the workspace is
  FLIP-translated (and clipped) in step. Closing collapses the track at once;
  opening keeps the collapsed track until the slide ends, so the workspace
  reflows once. Reduced motion commits at once and the sidebar only fades.
  The docked right inspector uses the same model
  (`useInspectorTrackMotion`): it keeps its full width at the right edge and
  slides with a transform; opening keeps the 0px right track while the panel
  slides in over the workspace (clipped in step) and commits the track when
  the slide ends; closing commits the 0px track at once and the panel slides
  out. In the medium drawer layout the workspace width follows the committed
  track after the push, never a width transition.
- Resize handles (`AdaptivePanelResizeHandle`, the `AdaptiveShellSplit`
  handle) draw no line: the divider is the surfaces' hairline. Hovered,
  focused or dragged they show a 4×64px pill grabber centred on it; with
  `hint` / `resizeHint` ("Drag to resize") a two-line hint (the label over the
  hint) follows after the tooltip delay, on the DOM side (never over a native
  page). Keyboard resize and the separator's aria stay.
- The workspace is an inline-size query container. Product resize geometry may
  retain a 320px workspace and give the inspector all remaining width; the shell
  accepts the measured widths and a standard root ref without owning preferences.
- Browser widths up to 1023px use one push drawer behavior, including medium.
- Electron widths above 640px retain docked grid tracks; only compact uses a drawer.
- The shared `adaptiveDrawerQuery` drives both the shell and panel-state policy.
- Drawers push the full-width workspace, with a full-cover right sheet in compact.
- Pass `compactSidebarFullWidth` for navigation that should fully cover the
  compact (`width <= 640px`) drawer viewport. Medium drawer widths always use
  the bounded `--adaptive-drawer-width` (`min(88vw, 320px)`) over the scrim so
  the workspace stays visible beside the sidebar.
- The window chrome toggle stays fixed while the workspace moves.
- Panels animate with transform and honor reduced motion: drawers then fade in
  place over the scrim and do not push the workspace.
- The always-mounted scrim keeps a promoted compositor layer and animates only
  opacity, preventing repeated mobile panel toggles from flashing.
- The workspace remains full width in compact and medium modes.

## Wrong use cases

Do not fetch domain data, import app stores, or add product selectors to this
block. Do not use it as a generic card or nested panel.

## Conversation frame, peek and auto-collapse

- `AdaptiveShellSplit` (inside `AdaptiveShellWorkspace`, under the titlebar):
  chat | browser pane. The chat column is its own `workspace` container,
  340–560px (`--browser-chat-width*`, default 400) and resizable by pointer
  or keyboard (`onChatWidthChange`, clamped). Pass `splitOpen` to
  `AdaptiveShell` while the pane is open: the inspector then stays closed;
  `toggleConversationSidePanel` keeps the two mutually exclusive.
- `leftPeek` with `AdaptiveShellPeekEdge`: the collapsed sidebar floats over
  the workspace as a card; the track stays collapsed, nothing reflows. Drive
  it with `useSidebarPeek(shellRef, { enabled, open?, onOpenChange? })`
  (uncontrolled, or controlled through `open` + `onOpenChange`): pass
  `peek.open` to `leftPeek` and `peek.show` to `AdaptiveShellPeekEdge`. It
  closes 240ms after the pointer leaves the sidebar (coming back cancels), at
  once on window blur, Escape or a press outside, and when the pointer leaves
  the document. Do not add your own `onPointerLeave` on the sidebar.
- A native view (Electron `WebContentsView`) hides the pointer from the DOM,
  so moving from the peeked sidebar straight onto the page sends no DOM event.
  The App forwards the host's signal; the DS stays free of Electron:
  - main process: on the attached view's `webContents` `input-event`
    (`mouseMove`/`mouseEnter`), send the window an IPC message, optionally with
    the point in window coordinates (view bounds + `input.x/y`);
  - renderer: call `peek.pointerOutside()` for that message, or
    `peek.pointerAt({ x, y })` when it carries a point (inside the sidebar rect
    keeps the peek, outside arms the 240ms dismiss).
- Beside the pane the chat column contains its layers (`contain: paint`): the
  conversation's wallpaper and glass resolve against the chat column and never
  paint over the pane. Without the pane the wallpaper spans the workspace.
- `useSidebarAutoCollapse(rootRef, { enabled, sidebarWidth, chatWidth })`:
  true while the page would be narrower than 720px with the sidebar open
  (`sidebarAutoCollapses`, with a 32px return margin). Pass
  `leftOpen={open && !collapsed}`.
- The pane enters with a transform; NativeViewSlot's tracker follows
  ancestors that move, so the native view tracks the page card.

## Cards frame (`frame="cards"`)

The approved app shell (2026-10-09). Default `frame="flat"` keeps today's
rectangular shell.

- The root paints one shell surface (`--shell-bg`, the window material):
  sidebar, traffic lights, title row and the gaps between cards. The title
  bar is transparent on it.
- Content sits in rounded cards (`--shell-card-bg`, `--shell-card-radius`
  12, one quiet `--shell-card-edge`, `--shell-card-shadow` none), inset
  `--shell-card-inset` (8) from the window and `--shell-card-gap` (8) from
  each other; the gap is the resize handle's lane. The workspace keeps a
  transparent 1px frame, so the title row stays on its flat-frame pixels and
  the cards start 1px under the 48px title row.
- `AdaptiveShellTitle` (first child of the workspace) holds the TitlebarShell.
  In cards it spans the inspector's column too: opening or sliding the
  inspector never moves the trailing icons. The inspector slide clips the
  workspace below the title row only.
- `AdaptiveShellCard` wraps the content under the title row (conversation,
  management pages). Flat: layout only. Do not wrap `AdaptiveShellSplit` (its
  chat column is a card and the BrowserPane beside it is the second card) or
  a standalone `BrowserPane` (the sheet is the card).
- The inspector is the side card under the title row; `InspectorShell` reads
  the frame and draws the card. `SettingsShell` puts its navigation on the
  shell and its detail pane in a card. Blocks read the frame through
  `useShellFrame()`.
- A wallpaper inside a card resolves against it and is clipped to its corners;
  no title bar overlaps a card, so the message list's top reserve drops to a
  plain inset (`--conversation-top-reserve`).
- Docked layout only: drawer layouts (phones, tablets) stay full-bleed.
- The sidebar peek is visible under reduced motion (the peek resets the
  opacity the reduced-motion rule gives a closed sidebar).

## Tags

shell, drawer, inspector, responsive, adaptive, motion
