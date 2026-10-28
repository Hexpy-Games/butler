# StepSortableList

`StepSortableList` is the design-system block for ordered chains of steps,
such as the 작업 of a 과제. Each chain is a head followed by its follow-up
steps (indented one level); each step is one item or a flat 묶음 of items,
drawn with `StackDeck`. Stacks never nest. It does not change
`SortableCardList`; it reuses `lib/dropZones` (`createDropZoneTracker`,
`measureDropBox`), `NavDropTarget`'s group ring and dnd-kit.

```tsx
<StepSortableList
  chains={chains}
  renderItem={(task, place) => ({ marker, title, meta, caption, trailing })}
  onEdit={(edit) => { setChains((current) => applyStepSortableEdit(current, edit)); save(edit, revision); }}
  canDrop={(edit) => allowed(edit)}
  labels={koLabels}
  deckLabels={koDeckLabels}
/>
```

## Rows

`[grip] [number or status glyph] [title ........ meta] / [caption] [⋯]` on a
`Card padding="md"`. The grip leads (SortableCardItem's order), pulled back by
`--space-xs`; running and pinned rows keep its slot empty and, without a
trailing control, keep the ⋯ room so statuses line up. A fanned 묶음's card is
compact: the title (two lines, the marker on the first card only), then
grip · caption · ⋯. Done rows are muted.

A single step's card is not interactive; only its grip and ⋯ are. A 묶음's
cards each carry `StackDeck`'s toggle, a sibling of the grip and ⋯ (no
control nests another): tab order is toggle, grip, ⋯, and the toggle's focus
ring is drawn on the card.

## Edits

`onEdit` receives one semantic edit, never a new array. Indexes are places
before the edit, so a product maps it to an API call with an optimistic
revision:

- `move_to_new_step`: a whole step moves to a new place in its chain;
- `split_stack`: an item leaves its 묶음 for a new step in the same chain;
- `join_stack`: an item or a whole step joins another step, flat;
- `move_between`: items move to another chain (`placement`: `new_step` or `join`).

Each carries `itemIds`, `from` and `to` (`{ chainId, stepIndex }`; for a new
step, the step it lands before, or `steps.length`). `applyStepSortableEdit`
applies one; `canDrop` refuses targets.

## Drag

- Pointer: a card or its grip, after 4 px (touch: 180 ms press). A collapsed
  묶음 drags as one step; a fanned card drags out alone (split). Running and
  pinned items never drag, and a pinned head takes no joins and nothing before it.
- Between steps: an accent `Separator` where the new step would go.
- Resting on a step for 250 ms (`STEP_SORTABLE_JOIN_DWELL`): a `NavDropTarget`
  group ring; the drop joins its 묶음. Fanned 묶음 take gaps only.
- Hit zones are the step boxes frozen at drag start, so feedback never moves them.
- The lifted copy is the row itself on the opaque raised surface with the drag
  shadow (`lift-in`), portaled to `<body>` with the list's theme, hanging
  `--space-3xl` below the pointer so the target stays in view. Its row context
  carries `outcome` for a caption that says what the drop does.
- Auto-scroll moves only the list's own pane scroller (top and bottom 12%).
- Keyboard: from the grip, with live-region announcements (`labels`).

`dragPreview` renders a static drag state (docs and previews).
