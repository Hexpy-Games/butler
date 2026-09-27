import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Reads computed style off a rendered specimen, so the spec beside it is the
 * value the browser actually applied (media overrides, theme, density), not a
 * copy. Re-reads when the element resizes (viewport overrides change sizes).
 */
export function useComputed<E extends HTMLElement, T>(read: (element: E, style: CSSStyleDeclaration) => T): [RefObject<E | null>, T | null] {
  const ref = useRef<E>(null);
  const [value, setValue] = useState<T | null>(null);
  const reader = useRef(read);
  reader.current = read;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => {
      const next = reader.current(element, getComputedStyle(element));
      setValue((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  return [ref, value];
}

/** "32px" → 32, rounded to a tenth; "normal" → 0. */
export function px(value: string): number {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : 0;
}
