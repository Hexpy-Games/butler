# TabStrip

## What is this component
The Browser area's tab row. Tabs are pills with a favicon slot, a truncating title and a close button; only the selected tab is filled (`--selection-strong`). Thin dividers sit between tabs and hide next to a filled (selected, hovered or focused) tab. Tabs shrink from `--tab-strip-tab-max-width` to `--tab-strip-tab-min-width`; past that the row scrolls sideways with edge fades and keeps the active tab in view. The minimum keeps the favicon and about five Korean characters readable. Near the minimum, unselected tabs drop their close button; the selected tab keeps it.

The close button shows only while its tab is hovered or has keyboard focus (`:focus-visible`), the selected tab included. It keeps its slot, so the title width never jumps; it fades on `--motion-fast` and appears at once under reduced motion. While hidden it takes no clicks. On touch layouts (`hover: none`) only the selected tab shows it. Middle-click, Delete/Backspace and Cmd/Ctrl+W still close any tab.

Tabs come in groups: "my tabs" (`kind: "mine"`) and one group per conversation (`kind: "conversation"`, muted). Beside other groups, each group is one outline pill (hairline border, no fill): `[title | tabs… | +]`. "My tabs" becomes a pill only beside other groups; alone it is plain pill tabs and the row's +. A click on the title folds the group (no chevron): the tabs and the pill's + slide closed on `--motion-base` (at once under reduced motion), and the title previews up to three favicons and "+N". The title's label is capped at `--tab-strip-chip-max-width` and truncates; its tooltip shows the full name and group state. Group state (`working`, `waiting`, `crashed`) shows on the title: the Butler thinking mark, a warning shield or a danger alert. Tab state (`loading`, `working`, `crashed`) replaces the favicon with a Spinner, the thinking mark or an alert.

Inside pills all open tabs share one width: the row's room after the pills' titles and + buttons, split across the open tabs and clamped to the min/max tokens. The strip measures it only when the row or a pill resizes.

## When to use this component
Browser tabs above a `NativeViewSlot`.

## Where to use this component
The App's Browser area.

## Why to use this component
Tab sizing, overflow, grouping, drag and keyboard behavior live in one place. The App container only maps Electron tab state to `groups` and handles intents.

## How to use this component
```tsx
<TabStrip groups={groups} activeTabId={activeId} panelId="browser-page" labels={appCopy.browser.tabStrip}
  onActivate={activate} onClose={close} onNewTab={openTab} onNewTabInGroup={openTabIn}
  onMove={(move) => setGroups((current) => applyTabStripMove(current, move))}
  onToggleGroup={(groupId, collapsed) => setCollapsed(groupId, collapsed)} />
```

- `onMove` receives `{ tabId, fromGroupId, toGroupId, index }`. `index` is the tab's final position in the target group. Dropping on a tab takes its slot, also across groups. Dropping on a group's title appends to that group. Keyboard: Cmd/Ctrl+Shift+Left/Right.
- `onClose` fires from the close button, a middle-click, or Delete/Backspace on the focused tab. Pick the next active tab in the container.
- `onNewTabInGroup(groupId)` ends each pill in its own + (a keyboard stop after the group's tabs, hidden while folded); while pills show, the row's + goes away.
- Leave out `onMove`, `onToggleGroup` or `onNewTab` to turn off reordering, folding or the new-tab button.
- `labels` is English by default. The App passes localized copy, including `tabCount(n)`, `newTabIn(group)`, `moreTabs(n)` and `moved(title, group, position)`.

## Who can use this component
The Browser area container.

## Best practice
Keep state in the container. Pass `panelId` (the `NativeViewSlot` id) so tabs point at the page.

## Wrong use cases
Do not use it for in-panel view switching; use `Tabs`.

## A conversation's own pane
`hideChip` drops the title and outline when the strip shows a single group
of any kind (a conversation's browser pane; the title bar names it) and shows
its tabs at full strength as plain pills, with the row's +. `trailing` holds row-end controls (Bring in a tab); they stay
out of the tab focus order. Keyboard moves and drag work as before.

## Tabs that are not web pages
A tab can pass its own `icon` (a ReactNode, such as `<FileText size="md" />`
or `<ImageIcon size="md" />` for a file in a docked viewer). It takes the
favicon slot instead of the globe; tab state (`loading`, `working`,
`crashed`) still replaces it. The tab keeps the same pill.

```tsx
<TabStrip hideChip panelId="file-viewer-page" activeTabId={activeId} labels={labels} onActivate={activate} onClose={close}
  groups={[{ id: "files", kind: "mine", tabs: files.map((file) => ({ id: file.id, title: file.title, icon: fileIcon(file) })) }]} />
```

## Tags
browser, tabs, tablist, groups, drag, reorder, conversation
