/** iOS: ids of the rows on screen when the chat list last came to rest. Only those mount selectable text. */
export function createSelectableRows() {
  let ids: ReadonlySet<string> = new Set();
  let viewable: ReadonlySet<string> = new Set();
  let moving = false;
  const listeners = new Set<() => void>();
  const commit = () => {
    if (viewable.size === ids.size && [...viewable].every(id => ids.has(id))) return;
    ids = viewable;
    listeners.forEach(listener => listener());
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    has: (id: string) => ids.has(id),
    onViewableItemsChanged({ viewableItems }: { viewableItems: { key: string }[] }) {
      viewable = new Set(viewableItems.map(item => item.key));
      if (!moving) commit();
    },
    begin() { moving = true; },
    settle() { moving = false; commit(); },
  };
}
export type SelectableRows = ReturnType<typeof createSelectableRows>;
