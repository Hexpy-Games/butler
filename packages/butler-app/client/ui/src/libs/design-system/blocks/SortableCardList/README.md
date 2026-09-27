# SortableCardList

`SortableCardList` is the design-system block for ordered card collections.
It owns pointer and keyboard sorting, drag-handle semantics, live reorder
announcements, focusable controls, reduced-motion styling, drag overlays, and
empty-state rendering.

Use a stable string `id` for every item. `onReorder` receives a new ordered
array, while `onRemove` receives an item id when the remove affordance is
needed. Product components should map their domain records into the neutral
`SortableCardListItem` shape and keep persistence in the owning store.

```tsx
<SortableCardList
  title="Backup models"
  items={items}
  onReorder={setItems}
  onRemove={(id) => removeModel(id)}
/>
```

## Motion
The dragged card lifts in a DragOverlay (`--motion-scale-lift`,
`--shadow-drag-lift`, spring easing) and its neighbors slide aside with dnd-kit
transforms timed by `--motion-base` and `--motion-ease-standard`. Reduced
motion moves neighbors at once and keeps only the shadow.

