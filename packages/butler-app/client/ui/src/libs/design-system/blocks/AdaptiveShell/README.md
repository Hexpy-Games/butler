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

- Expanded layouts use resizable grid tracks. The left track never
  interpolates: the docked sidebar slides with a transform while the
  workspace is FLIP-translated (and clipped) in step. Closing collapses the
  track at once; opening keeps the collapsed track until the slide ends, so
  the workspace reflows once. Reduced motion commits at once and the sidebar
  only fades. The docked right inspector (`useInspectorTrackMotion`) keeps
  its full width at the right edge and slides with a transform, while the
  right track's width animates on the same tokens (slow, emphasized): the
  workspace narrows as the panel opens and widens as it closes, in lockstep.
  Reduced motion and live resizing commit the track at once. In the medium
  drawer layout the workspace width follows the committed track after the
  push, never a width transition.
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
- The pane opens and closes on one motion, whatever it holds (`--motion-slow`,
  `--motion-ease-emphasized`): the pane keeps its final size and travels on a
  transform, the chat card's edge and the title row's chat group follow it. A
  closing pane stays mounted, with the node it last had, until the motion ends.
  A pane with a native view on screen waits for its still before it travels
  (NativeViewSlot hold, at most one motion's length): opening, the whole motion
  waits; closing, the chat starts at once under the pane.
  A toggle mid-motion continues from the frame on screen. A resize settles any
  running motion and is immediate. The first mount, a new `contextKey` (another
  conversation) and reduced motion place everything at once; reduced motion
  fades an opening pane in. Render the split whether or not the pane is open,
  so the chat stays mounted through the motion.
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
- Whatever the pane holds fills the slot's height, as the chat column's child
  does: the browser sheet, or a docked file viewer in an `AdaptiveShellCard`
  (cards frame: the viewer is the second card) stays full height however
  short its content. Scroll inside it with `ScrollArea fill`.

## Cards frame (`frame="cards"`)

The approved app shell (2026-10-09). Default `frame="flat"` keeps today's
rectangular shell.

- The root paints one shell surface (`--shell-bg`, the window material):
  sidebar, traffic lights, title row and the gaps between cards. The title
  bar is transparent on it.
- `--shell-bg` follows `--sidebar-bg`, which the root picks per platform:
  macOS Electron uses `--mac-sidebar-bg` (0.30 light, 0.50 dark) over the
  native "sidebar" vibrancy, Windows uses `--windows-sidebar-bg` over acrylic,
  and browsers and Linux keep `--sidebar-bg` (0.52 light, 0.72 dark; no native
  blur). `.sidebar-solid` sets all three to the near-opaque fill.
- Text on the shell (sidebar and the cards title row) follows the same rule:
  the root picks `--sidebar-text-secondary` / `--sidebar-text-tertiary` per
  platform (`--mac-sidebar-text-*`, `--windows-sidebar-text-*`), and those
  scopes map the secondary and tertiary text roles (`--color-text-*`,
  `--text-*`, `--muted-foreground`, `--menu-group-label-color`) to them.
  They equal the global tones except Windows dark, where acrylic over a light
  desktop lifts the shell (#1187); a solid shell takes the global tones.
- Sidebar row fills follow the surface too, never a platform check. The root
  picks `--sidebar-hover-bg` / `--sidebar-selected-bg` with the shell layer
  (`--mac-sidebar-*` on macOS, `--windows-sidebar-*` on Windows; browsers and
  Linux leave them unset) and the docked sidebar maps them to NavRow's
  `--nav-hover-bg` / `--nav-selected-bg`. Light tinted shells (macOS and
  Windows translucent, `.sidebar-solid` everywhere) set the white family;
  the white base of web and Linux translucent, the drawer and the peek card
  (both clear them) and all of dark keep the `--selection` shades.
- Content sits in rounded cards (`--shell-card-bg`, `--shell-card-radius`
  12, one quiet `--shell-card-edge`, `--shell-card-shadow` none), inset
  `--shell-card-inset` (8) from the window and `--shell-card-gap` (8) from
  each other; the gap is the resize handle's lane. The workspace keeps a
  transparent 1px frame, so the title row stays on its flat-frame pixels and
  the cards start 1px under the 48px title row. The docked sidebar column
  keeps the same 1px top frame, so its title row and first row fill line up
  with the workspace's title row and the cards' top edge (a peeked sidebar is
  its own card and keeps its inset).
- `AdaptiveShellTitle` (first child of the workspace) holds the TitlebarShell.
  In cards it spans the inspector's column too: opening or sliding the
  inspector never moves the trailing icons. The inspector slide clips the
  workspace below the title row only.
- `AdaptiveShellCard` wraps the content under the title row (conversation,
  management pages). Flat: layout only. Do not wrap `AdaptiveShellSplit` (its
  chat column is a card and the BrowserPane beside it is the second card) or
  a standalone `BrowserPane` (the sheet is the card).
- The browser sheet's fill is a `--shell-sheet-tint` ink tint of the card
  surface and the page card's shadow on it is `--shell-page-shadow`. Light
  keeps both faint (1%, a tight shadow), so the sheet lifts off the shell like
  the chat card and the 8px gap reads as 8px; dark keeps 2.5% and the page
  card's usual shadow.
- Session details sit in the `ConversationShell` aside and a page's detail
  in the `ManagementPage` aside, both inside the content card.
  `SettingsShell` puts its navigation on the shell and its detail pane in a
  card. Blocks read the frame through
  `useShellFrame()`.
- A wallpaper inside a card resolves against it and is clipped to its corners;
  no title bar overlaps a card, so the message list's top reserve drops to a
  plain inset (`--conversation-top-reserve`).
- A `TabRail` in the conversation's `rail` slot (`ConversationShell`) sits
  inside the chat card: full and compact rails 16px from its top and end
  edge, a shelf 8px into it (`--conversation-rail-shelf-top`). In the flat
  frame they start under the title bar. The rail measures the card, so the
  sidebar and the inspector count toward its mode.
- The window bounds every card: the workspace never grows past the window
  (it keeps a zero minimum height) and the inspector card's height comes from
  its top and bottom insets alone. Long content scrolls inside its card; the
  8px bottom inset and the bottom corners always show.
- Docked layout only: drawer layouts (phones, tablets) stay full-bleed.
- The sidebar peek is visible under reduced motion (the peek resets the
  opacity the reduced-motion rule gives a closed sidebar).

## Tags

shell, drawer, inspector, responsive, adaptive, motion
