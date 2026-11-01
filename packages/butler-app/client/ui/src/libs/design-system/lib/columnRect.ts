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

/** Finite transforms can move a fixed-width column without resizing it. */
function columnMotion(elements: HTMLElement[]): Animation[] {
  return elements.flatMap(element => element.getAnimations()).filter(animation =>
    animation.playState === "running" && animation.timeline === document.timeline
    && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)));
}

/**
 * Reports `column`'s rect once laid out and again only when it changes: on column or `frame` resizes
 * (including intermediate containers), window resizes and the aside docking or leaving
 * (`dockedAsideSlot`: the docked aside's `data-slot`, `null` while none is docked). `top` is the frame's.
 * Rechecks after finite layout motion finishes. No scroll listener or idle polling; equal values are not reported twice.
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
    let disposed = false;
    let settling = false;
    const containers: HTMLElement[] = [];
    for (let element: HTMLElement | null = column; element; element = element.parentElement) {
      containers.push(element);
      if (element === frame) break;
    }
    const update = () => {
      if (disposed) return;
      const motion = columnMotion(containers);
      if (motion.length && !settling) {
        settling = true;
        void Promise.allSettled(motion.map(animation => animation.finished)).then(() => {
          settling = false;
          update();
        });
      }
      const { left, right } = column.getBoundingClientRect();
      const next = { left, right: contentRight(frame, right, dockedAsideSlot), top: (frame ?? column).getBoundingClientRect().top };
      if (sameRect(last, next)) return;
      last = next;
      callback.current?.(next);
    };
    const observer = new ResizeObserver(update);
    for (const element of containers) observer.observe(element);
    window.addEventListener("resize", update);
    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [reporting, column, frame, dockedAsideSlot]);
}
