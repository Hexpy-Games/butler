import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";

const KEY_STEPS: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 };

export function useAnchoredScroll(anchor: "start" | "end", weeks: number) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && anchor === "end") viewport.scrollLeft = viewport.scrollWidth;
  }, [anchor, weeks]);
  return viewportRef;
}

/** Roving focus (one tab stop, arrows move by day and week) and the hovered or focused cell for the tooltip. */
export function useCellFocus(days: readonly unknown[], initial: number) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const tabIndex = Math.min(focusIndex ?? initial, days.length - 1);
  const indexOf = (target: EventTarget) => {
    const value = (target as HTMLElement).closest?.("[data-index]")?.getAttribute("data-index");
    return value === null || value === undefined ? null : Number(value);
  };
  const focusCell = (index: number) => {
    setFocusIndex(index);
    setActive(index);
    gridRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
  };
  return {
    gridRef,
    tabIndex,
    active,
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      const current = indexOf(event.target);
      if (current === null) return;
      const step = KEY_STEPS[event.key];
      const next = step !== undefined ? current + step : event.key === "Home" ? 0 : event.key === "End" ? days.length - 1 : null;
      if (next === null) return;
      event.preventDefault();
      if (next >= 0 && next < days.length) focusCell(next);
    },
    onPointerOver(event: PointerEvent<HTMLDivElement>) { setActive(indexOf(event.target)); },
    onPointerLeave() { setActive(null); },
    onFocus(event: FocusEvent<HTMLDivElement>) {
      const index = indexOf(event.target);
      if (index === null) return;
      setFocusIndex(index);
      if (event.target.matches(":focus-visible")) setActive(index);
    },
    onBlur() { setActive(null); },
  };
}
