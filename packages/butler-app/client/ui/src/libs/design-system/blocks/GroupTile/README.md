# GroupTile

## What is this block
`GroupTile` is a group (a scrap group, a bookmark folder) as a folder card on
the Library grid. Its 16:10 slot is the same as a `LibraryCard`'s and holds a
mosaic of the group's newest items: one item fills it, two sit side by side,
three are a tall one with two stacked, four or more are a 2×2. Crops are whole
(`contain`) on the matte; a text scrap shows its words, a document its lines,
a bookmark its favicon and host. An empty group shows a folder glyph and the
empty label. Below: a folder glyph with the name, the count and latest date,
and a ⋯ menu.

`GroupTileMore` is the last cell of a full row: “+N”, “N more groups” and
“View all”, opening the kind's full view.

## When to use this block
The first row of a kind section (스크랩, 북마크) on the Library main screen,
in the same `Grid` as the cards.

## Container vs Presenter
The App maps a group to its name, meta, previews (its four newest items) and
menu, and owns the drag: it sets `drop` while a card or pick is over the tile
and reads `data-group-tile` (the `dropId`) for targeting.

## Usage

```tsx
<Grid columns={{ compact: "2", base: "3", wide: "4" }} gap="md">
  {groups.map((g) => <GroupTile key={g.id} dropId={g.id} name={g.name} meta={g.meta} previews={g.previews} emptyLabel="Empty" onOpen={() => open(g)} />)}
  {more > 0 ? <GroupTileMore count={more} label={`${more} more groups`} meta="View all" onOpen={viewAll} /> : null}
</Grid>
```

## Accessibility
The tile is one button named by `label` (default: the name); the menu is a
separate button; the mosaic is hidden from assistive technology.

## Responsive behavior
The tile fills its grid cell; the slot keeps 16:10 at every width.

## Wrong use cases
- Do not crop previews to fill the cells; pass crops as captured.
- Do not use it for a single item (use `LibraryCard`).

## Tags
library, group, folder, album, mosaic, drop
