import { useLayoutEffect, useState, type RefObject } from "react";

export interface SlotRect {
  left: number;
  right: number;
  top: number;
  midY: number;
  /** Centre of the slot's first IconSlot (the card's first text line). */
  firstLineY: number;
}

/**
 * Rects of every `[data-graph-slot]` relative to `origin`, measured after
 * layout and again only when the host or a slot resizes (ResizeObserver).
 * Scrolling never re-measures: rects are in content coordinates.
 */
export function useSlotRects(host: RefObject<HTMLElement | null>, origin: RefObject<Element | null>, revision: unknown) {
  const [rects, setRects] = useState<Map<string, SlotRect>>(() => new Map());
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => {
      const base = origin.current?.getBoundingClientRect();
      if (!base) return;
      const next = new Map<string, SlotRect>();
      element.querySelectorAll<HTMLElement>("[data-graph-slot]").forEach((slot) => {
        const box = slot.getBoundingClientRect();
        const glyph = slot.querySelector('[data-slot="icon-slot"]')?.getBoundingClientRect();
        next.set(slot.dataset.graphSlot!, {
          left: box.left - base.left,
          right: box.right - base.left,
          top: box.top - base.top,
          midY: box.top - base.top + box.height / 2,
          firstLineY: glyph ? glyph.top - base.top + glyph.height / 2 : box.top - base.top + box.height / 2,
        });
      });
      setRects(next);
      setSize({ width: element.scrollWidth, height: element.scrollHeight });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.querySelectorAll("[data-graph-slot]").forEach((slot) => observer.observe(slot));
    measure();
    return () => observer.disconnect();
  }, [host, origin, revision]);
  return { rects, size };
}

/** Move focus to a task's activatable element and report the selection. */
export function focusTask(host: HTMLElement, id: string | undefined, onSelect?: (id: string) => void): boolean {
  if (!id) return false;
  const slot = host.querySelector<HTMLElement>(`[data-graph-slot="${CSS.escape(id)}"]`);
  const target = slot?.querySelector<HTMLElement>('[tabindex="0"], button, [role="button"]') ?? slot;
  if (!target) return false;
  target.focus();
  onSelect?.(id);
  return true;
}

/** The task id of the slot that contains the event target. */
export function slotOf(target: EventTarget | null): string | undefined {
  return (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-graph-slot]")?.dataset.graphSlot;
}
