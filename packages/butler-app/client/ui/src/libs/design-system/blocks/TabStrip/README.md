# TabStrip

## What is this component
The Browser area's tab row. Tabs have a favicon slot, a truncating title and a close button. They shrink from `--tab-strip-tab-max-width` to `--tab-strip-tab-min-width`; past that the row scrolls sideways with edge fades and keeps the active tab in view. The minimum keeps the favicon and about five Korean characters readable. Near the minimum, unselected tabs drop their close button; the selected tab keeps it. Group chips are secondary: their label is capped at `--tab-strip-chip-max-width` (a folded chip is narrower) and truncates, and the chip's tooltip shows the full name and group state.

Tabs come in groups: "my tabs" (`kind: "mine"`) and one group per conversation (`kind: "conversation"`, muted). A group shows a labelled chip that folds and unfolds it. The `mine` chip only appears beside other groups. Group state (`working`, `waiting`, `crashed`) shows on the chip: the Butler thinking mark, a warning shield or a danger alert. Tab state (`loading`, `working`, `crashed`) replaces the favicon with a Spinner, the thinking mark or an alert.

## When to use this component
Browser tabs above a `NativeViewSlot`.

## Where to use this component
The App's Browser area.

## Why to use this component
Tab sizing, overflow, grouping, drag and keyboard behavior live in one place. The App container only maps Electron tab state to `groups` and handles intents.

## How to use this component
```tsx
<TabStrip groups={groups} activeTabId={activeId} panelId="browser-page" labels={appCopy.browser.tabStrip}
  onActivate={activate} onClose={close} onNewTab={openTab}
  onMove={(move) => setGroups((current) => applyTabStripMove(current, move))}
  onToggleGroup={(groupId, collapsed) => setCollapsed(groupId, collapsed)} />
```

- `onMove` receives `{ tabId, fromGroupId, toGroupId, index }`. `index` is the tab's final position in the target group. Dropping on a tab takes its slot, also across groups. Dropping on a chip appends to that group. Keyboard: Cmd/Ctrl+Shift+Left/Right.
- `onClose` fires from the close button, a middle-click, or Delete/Backspace on the focused tab. Pick the next active tab in the container.
- Leave out `onMove`, `onToggleGroup` or `onNewTab` to turn off reordering, folding or the new-tab button.
- `labels` is English by default. The App passes localized copy, including `tabCount(n)` and `moved(title, group, position)`.

## Who can use this component
The Browser area container.

## Best practice
Keep state in the container. Pass `panelId` (the `NativeViewSlot` id) so tabs point at the page.

## Wrong use cases
Do not use it for in-panel view switching; use `Tabs`.

## A conversation's own pane
`hideChip` drops the chip when the strip shows a single group of any kind (a
conversation's browser pane; the title bar names it) and shows its tabs at
full strength. `trailing` holds row-end controls (Bring in a tab); they stay
out of the tab focus order. Keyboard moves and drag work as before.

## Tags
browser, tabs, tablist, groups, drag, reorder, conversation
