import { useEffect, useRef } from "react";

/**
 * The content column a block's background keeps clear: the column's left and right edges and the block's
 * top, in client CSS px. A docked aside extends `right` to its own far edge. Scrolling moves none of them.
 */
export interface ColumnRect {
  left: number;
  right: number;
  top: number;
}

const sameRect = (a: ColumnRect | null, b: ColumnRect) =>
  a !== null && a.left === b.left && a.right === b.right && a.top === b.top;

/** The docked aside's far edge (`[data-slot=asideSlot][data-layout=docked]` in `frame`), or the column's. */
function contentRight(frame: HTMLElement | null, columnRight: number, asideSlot: string | null): number {
  const aside = asideSlot ? frame?.querySelector<HTMLElement>(`[data-slot="${asideSlot}"][data-layout="docked"]`) : null;
  return aside ? Math.max(columnRight, aside.getBoundingClientRect().right) : columnRight;
}

/**
 * Reports `column`'s rect once laid out and again only when it changes: on column or `frame` resizes
 * (ResizeObserver, read right after layout), window resizes and the aside docking or leaving
 * (`dockedAsideSlot`: the docked aside's `data-slot`, `null` while none is docked). `top` is the frame's.
 * No scroll listener and no per-frame work; equal values are not reported twice.
 */
export function useColumnRect(
  column: HTMLElement | null,
  frame: HTMLElement | null,
  dockedAsideSlot: string | null,
  onColumnRect: ((rect: ColumnRect) => void) | undefined,
) {
  const callback = useRef(onColumnRect);
  useEffect(() => {
    callback.current = onColumnRect;
  });
  const reporting = onColumnRect !== undefined;
  useEffect(() => {
    if (!reporting || !column) return undefined;
    let last: ColumnRect | null = null;
    const update = () => {
      const { left, right } = column.getBoundingClientRect();
      const next = { left, right: contentRight(frame, right, dockedAsideSlot), top: (frame ?? column).getBoundingClientRect().top };
      if (sameRect(last, next)) return;
      last = next;
      callback.current?.(next);
    };
    const observer = new ResizeObserver(update);
    observer.observe(column);
    if (frame) observer.observe(frame);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [reporting, column, frame, dockedAsideSlot]);
}
