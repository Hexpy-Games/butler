# NavDropTarget

## What is this block
`NavDropTarget` wraps one draggable sidebar tree item and shows where a dragged
row would land: a line before or after the row header, or a ring for dropping
inside a folder or grouping two conversations (with a short hint).
`NavRootDropZone` is the dashed "move to the top level" zone shown while a row
is dragged.

## When to use this block
Use it for sidebar trees whose rows can be reordered or moved by drag and drop.

## Container vs Presenter
The product container owns the drag data (native drag events, what may drop
where) and resolves the drop with `lib/dropZones` (`createDropZoneTracker`,
`measureDropBox`) inside a `NavDropScope`; it passes `drop`, `dragging` and
the row header box (`indicator`, for the group ring). The block owns every
visual state and its motion; product CSS never styles drop indicators.

## Similar blocks
- `SortableCardList`: keyboard and pointer reordering of cards (dnd-kit,
  which also hit-tests on rects measured before the drag moves anything).
- `CollapsibleNavGroup`: the folder row inside a drop target.

## Usage

```tsx
import { NavDropScope, NavDropTarget, NavRow, createDropZoneTracker, measureDropBox } from "@/butler-ds";

const tracker = useMemo(() => createDropZoneTracker<string>({ onChange: setHit }), []);
<NavDropScope active={dragging} onDragOver={(e) => {
  e.preventDefault();
  tracker.update(e.clientY, rows.map((row) => ({ key: row.key,
    ...measureDropBox(headerOf(row), e.currentTarget), combine: canGroup(row) })), e.timeStamp);
}} onDrop={commit}>
  <CollapsibleList>
    {rows.map((row) => <NavDropTarget key={row.key} draggable drop={dropFor(row, hit)}
      dragging={row.key === source} indicator={headerBox} hint={copy.groupTogether}
      onDragStart={start}><NavRow label={row.title} onClick={open} /></NavDropTarget>)}
  </CollapsibleList>
</NavDropScope>
```

## Motion
An insert opens a one-row slot where the row would land (`--nav-drop-gap`,
row height plus row spacing): the target (before) and every later row,
including rows after the enclosing folders, translate down on
`--motion-base` / `--motion-ease-standard`, and a 2px accent line fades in
centered in the slot. A group or drop-inside target gets an inset accent
ring and tint over its header; its box never changes and no row moves.
Reduced motion: no slot or travel; the line and ring fade in.

## Drop zones
`lib/dropZones` hit-tests layout boxes (offset geometry), so translate and
scale never move the zones under the pointer. Per row: top 25% before,
middle 50% combine (group or inside), bottom 25% after; a row that cannot
combine splits 50/50; an expanded folder has no after zone. Boundaries and
the current row hold 4px of hysteresis; entering combine waits 150ms (a timer
commits it even without further drag events).

The Space sidebar keeps native drag and drop (a dragged conversation can be
dropped into the composer as a reference), so the dragged row stays in
place, dimmed, while the browser's drag image follows the pointer.

## Accessibility
Drop feedback is visual; pair pointer dragging with a keyboard path (a "Move
to..." menu item) as the Space sidebar does.

## Responsive behavior
The indicator follows the measured row header, so it works for every sidebar
density.

## Wrong use cases
- Do not use it for lists without drag and drop; use `NavRow` alone.
- Do not add drop indicator CSS in product code.

## Outside payloads
Picked page elements or a browser tab dragged over the sidebar use
`drop="outside"`: an inset ring and a label beside the row (`hint`, e.g. Add
to ‘Trip’), or with `invalid` a dashed danger ring and the reason. Wrap the
tree in `NavDropScope payload="outside"`: no row opens a slot, reorders or
expands, so row positions never change during the drag. `useNavDropAutoScroll`
scrolls the list while the pointer is within 40px of its top or bottom edge
(`navDropAutoScrollStep` is the per-frame step) and `NavDropScope autoScroll`
shows the edge band.

## Tags
navigation, sidebar, drag, drop, reorder
