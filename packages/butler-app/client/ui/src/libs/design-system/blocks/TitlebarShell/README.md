# TitlebarShell

## What is this component
A compact titlebar composition for shell previews.

## When to use this component
Use it for titlebar-like app chrome and viewer fixtures.

## Where to use this component
Use it inside `ChromeFrame` or product titlebar presenters.

## Why to use this component
It standardizes app identity, subtitle, and trailing controls.

## How to use this component
Pass title, optional subtitle, leading, trailing nodes, and optional
windowControls for App-owned platform controls that must anchor to the window
edge instead of joining normal toolbar flow.

## Who can use this component
Shell components and DS fixtures.

## Best practice
Keep window drag, IPC, and routing behavior outside this block.

## Wrong use cases
Do not use it for page headers. Use `DashboardHeader` or `SettingsHeader`.

## Auto-sized leading control
`leadingSize="auto"` lets `leading` hold a control at its own size (the
standalone Browser's conversation button) instead of the title-line square.
The control is pulled back by its inner inset so its label starts where the
title would; the collapsed-sidebar inset on the bar is unchanged.

## Two groups that follow the browser split
The conversation titlebar reads `[title subtitle ⋯ ······ 세션 정보][browser]`:

- `titleActions`: controls after the whole title line, title then subtitle
  (the conversation's ⋯ menu), on screen and in reading order, so title and
  subtitle read as one unit. They sit on the title line, centred on it, and
  never shrink: a truncated subtitle ends in its ellipsis and ⋯ follows it,
  never overlapping the text.
- `chatTrailing`: controls at the chat card's end (the 세션 정보 toggle). With
  the browser pane closed they sit one button gap before `trailing`.
- `splitChatWidth`: while the browser pane is open, pass the same `chatWidth`
  AdaptiveShellSplit gets, in the same render. The title, its actions and
  `chatTrailing` then span the chat card, the end controls keeping the inset
  `trailing` has from the card at the window edge, and `trailing` (the browser
  toggle) stays over the pane. A drag moves the chat card and the group
  together; when the pane opens or closes AdaptiveShellSplit moves the group with
  the chat card's edge.
  Omit it while the pane is closed.

The chat card's offsets inside the title row come from AdaptiveShell's cards
frame (`--titlebar-card-start`, `--titlebar-card-end`). Without the new props
the bar renders exactly as before.

The 세션 정보 toggle is an `IconButton` with `AppleReminder`. While the pane is
open it passes `pressed` and `tone="butler"`, as the browser toggle does.

## Pane toggles fill with their pane's surface
Every title-bar toggle that opens a pane declares it with `IconButton pane`:
`pane="aside"` (세션 정보), `pane="browser"` (the browser toggle) and
`pane="viewer"` (the file viewer's toggle, a card pane in the split). While
the pane is open (`pressed`), the button fills with that pane's own surface,
opaque, so it reads as joined to the pane: `--tinted-glass-tint` for the
aside, `--browser-pane-bg` for the browser, `--shell-card-bg` for a card
pane. The blue icon (`tone="butler"`) stays; `aria-pressed` is the announced
state. The task graph opens a full-window dialog, not a pane, so its toggle
declares no pane and stays unfilled; so does ⋯ (a menu). When a
request waits for an answer, pass `indicator` and say so in the label (“세션 정보
· 답을 기다리는 요청 있음”), since the dot itself is hidden from assistive tech;
the dot reads the same over either tone.

## Tags
titlebar, shell, chrome

## Back on nested screens
Pass `back={{ label, onBack }}` on a nested screen (서랍 › 스크랩, a group in it, an item's detail): a back button
sits at the title's start and goes up one level. Top-level screens pass nothing, so it is hidden there. The App binds
⌘[ (macOS) and Alt+← to the same action; the label is the tooltip and accessible name (“Back to Scraps”).
