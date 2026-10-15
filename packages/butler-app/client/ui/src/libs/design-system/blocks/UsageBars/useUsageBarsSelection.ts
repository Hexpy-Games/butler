import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { bucketAtPointer } from "./usageBarsLayout";

interface SelectionOptions {
  /** Keys of the drawn buckets, in order (empty when nothing is drawn). */
  keys: readonly string[];
  slots: number;
  selectedIndex: number | null | undefined;
  onSelect: ((index: number | null) => void) | undefined;
  rootRef: RefObject<HTMLElement | null>;
  plotRef: RefObject<HTMLElement | null>;
}

export interface UsageBarsSelection {
  selected: number | null;
  plotHandlers: {
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  };
  rootHandlers: {
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
  };
}

/** The next index for a navigation key, or undefined when the key is not ours. */
function keyTarget(key: string, current: number | null, count: number): number | null | undefined {
  if (key === "ArrowRight") return current === null ? 0 : Math.min(count - 1, current + 1);
  if (key === "ArrowLeft") return current === null ? count - 1 : Math.max(0, current - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  // Esc with nothing selected stays with the surrounding surface (closes a popover).
  if (key === "Escape" && current !== null) return null;
  return undefined;
}

/**
 * Drops a selection whose bucket went away: the index fell out of range (the
 * buckets emptied or shrank) or a different bucket now sits at that index
 * (a new window or chat). The caller hears onSelect(null).
 */
function useClearStaleSelection(keys: readonly string[], raw: number | null, selected: number | null, clear: () => void): void {
  const held = useRef<{ index: number; key: string } | null>(null);
  useEffect(() => {
    const previous = held.current;
    const shifted = previous !== null && selected === previous.index && keys[selected] !== previous.key;
    if ((raw !== null && selected === null) || shifted) {
      held.current = null;
      clear();
      return;
    }
    held.current = selected === null ? null : { index: selected, key: keys[selected]! };
  }, [clear, keys, raw, selected]);
}

/**
 * Selection for UsageBars: mouse hover follows the pointer, a touch tap toggles
 * a bucket, arrows/Home/End move, Esc and blur clear, a press outside clears.
 * Controlled when `selectedIndex` is passed, otherwise kept here. A selection
 * whose bucket goes away is cleared (useClearStaleSelection).
 */
export function useUsageBarsSelection({ keys, slots, selectedIndex, onSelect, rootRef, plotRef }: SelectionOptions): UsageBarsSelection {
  const count = keys.length;
  const [own, setOwn] = useState<number | null>(null);
  const raw = selectedIndex === undefined ? own : selectedIndex;
  const selected = raw !== null && Number.isInteger(raw) && raw >= 0 && raw < count ? raw : null;

  const select = useCallback((next: number | null) => {
    if (next === selected) return;
    if (selectedIndex === undefined) setOwn(next);
    onSelect?.(next);
  }, [onSelect, selected, selectedIndex]);
  const clear = useCallback(() => {
    if (selectedIndex === undefined) setOwn(null);
    onSelect?.(null);
  }, [onSelect, selectedIndex]);
  useClearStaleSelection(keys, raw, selected, clear);

  const pick = (event: PointerEvent<HTMLElement>) => {
    const plot = plotRef.current;
    return plot ? bucketAtPointer(event.clientX, plot.getBoundingClientRect(), slots, count) : null;
  };

  useEffect(() => {
    if (selected === null) return undefined;
    const outside = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) select(null);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [rootRef, select, selected]);

  return {
    selected,
    plotHandlers: {
      onPointerMove: (event) => { if (event.pointerType === "mouse") select(pick(event)); },
      onPointerDown: (event) => {
        const index = pick(event);
        select(event.pointerType !== "mouse" && index === selected ? null : index);
      },
      onPointerLeave: (event) => {
        if (event.pointerType === "mouse" && document.activeElement !== rootRef.current) select(null);
      },
    },
    rootHandlers: {
      onKeyDown: (event) => {
        if (count === 0) return;
        const next = keyTarget(event.key, selected, count);
        if (next === undefined) return;
        event.preventDefault();
        if (event.key === "Escape") event.stopPropagation();
        select(next);
      },
      onBlur: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) select(null);
      },
    },
  };
}
