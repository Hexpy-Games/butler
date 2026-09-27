import { useLayoutEffect, useRef } from "react";

/**
 * Centers the selected result row inside the results scroller when the
 * popover opens. Later filtering keeps the user's scroll position.
 */
export function useSelectedRowIntoView() {
  const resultsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = resultsRef.current;
    const selected = scroller?.querySelector<HTMLElement>(
      '[data-slot="filtered-select-item"][data-selected="true"]',
    );
    if (!scroller || !selected) return;
    const row = selected.getBoundingClientRect();
    const rowTop = row.top - scroller.getBoundingClientRect().top;
    if (rowTop >= 0 && rowTop + row.height <= scroller.clientHeight) return;
    scroller.scrollTop += rowTop - (scroller.clientHeight - row.height) / 2;
  }, []);
  return resultsRef;
}
