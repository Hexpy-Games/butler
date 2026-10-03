import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Placement only changes on container resize. Keep an open overflow mounted on widening. */
export function useComposerOverflow(ref: RefObject<HTMLDivElement | null>, trigger: RefObject<HTMLButtonElement | null>, onNarrow?: () => void) {
  const [narrow, setNarrow] = useState(false);
  const [open, setOpen] = useState(false);
  const current = useRef({ narrow: false, open: false, width: 0 });
  const notify = useRef(onNarrow);
  notify.current = onNarrow;
  useLayoutEffect(() => {
    const container = ref.current?.closest('[data-test-class~="composer-wrap"]');
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry!.contentRect.width;
      const next = width <= 520;
      const state = current.current;
      state.width = width;
      if (state.narrow === next || (state.open && !next)) return;
      const secondary = ref.current?.querySelector('[data-slot="composer-secondary"]');
      const focusMoved = secondary?.contains(document.activeElement) || secondary?.querySelector('[data-state="open"]');
      state.narrow = next;
      if (next) notify.current?.();
      setNarrow(next);
      if (next && focusMoved) requestAnimationFrame(() => trigger.current?.focus());
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [ref, trigger]);
  const changeOpen = (next: boolean) => {
    current.current.open = next;
    setOpen(next);
    if (!next && current.current.width > 520) {
      current.current.narrow = false;
      setNarrow(false);
    }
  };
  return { narrow, open, changeOpen };
}
