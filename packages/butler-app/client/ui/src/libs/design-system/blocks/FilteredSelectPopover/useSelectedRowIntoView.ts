import { useLayoutEffect, useRef } from "react";

/**
 * When the popover opens: the results keep their opening height while the
 * list is filtered (a short list fits, and the panel does not jump as you
 * type), and the selected row is centered inside the results scroller.
 * Later filtering keeps the user's scroll position.
 */
export function useSelectedRowIntoView() {
  const resultsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const scroller = resultsRef.current;
    if (!scroller) return;
    const frame = scroller.parentElement;
    if (frame) frame.style.minHeight = `${frame.getBoundingClientRect().height}px`;
    const selected = scroller.querySelector<HTMLElement>(
      '[data-slot="filtered-select-item"][data-selected="true"]',
    );
    if (!selected) return;
    const row = selected.getBoundingClientRect();
    const rowTop = row.top - scroller.getBoundingClientRect().top;
    if (rowTop >= 0 && rowTop + row.height <= scroller.clientHeight) return;
    scroller.scrollTop += rowTop - (scroller.clientHeight - row.height) / 2;
  }, []);
  return resultsRef;
}
