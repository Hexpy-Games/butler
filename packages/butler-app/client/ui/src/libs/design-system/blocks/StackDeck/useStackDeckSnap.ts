import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../../lib/motion";

/** Ms after a sideways scroll stops before the row settles on a whole card. */
export const STACK_DECK_SETTLE_MS = 140;
/** Cards a fanned row shows whole. */
const PER_VIEW = 2;

/**
 * The fanned row's scroller: once a sideways scroll ends (never while a pointer or finger is
 * down) it settles on the nearest whole card, and it reports how many cards are out of view on
 * each side and whether the row is moving (the edge fades show only then).
 */
export function useStackDeckSnap(count: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hidden, setHidden] = useState({ start: 0, end: Math.max(0, count - PER_VIEW) });
  const [scrolling, setScrolling] = useState(false);
  useEffect(() => {
    const view = ref.current;
    if (!view) return undefined;
    let timer = 0;
    let down = false;
    const cards = () => view.querySelectorAll<HTMLElement>("[data-stack-deck-card]");
    const measure = () => {
      const list = cards();
      const step = list.length > 1 ? list[1]!.offsetLeft - list[0]!.offsetLeft : 1;
      const start = Math.max(0, Math.round(view.scrollLeft / step));
      setHidden({ start, end: Math.max(0, list.length - PER_VIEW - start) });
      return step;
    };
    const settle = () => {
      if (down) return;
      const step = measure();
      const target = Math.min(view.scrollWidth - view.clientWidth, Math.round(view.scrollLeft / step) * step);
      if (cards().length > PER_VIEW && Math.abs(target - view.scrollLeft) > 1) {
        view.scrollTo({ left: target, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      } else setScrolling(false);
    };
    const later = () => { setScrolling(true); window.clearTimeout(timer); timer = window.setTimeout(settle, STACK_DECK_SETTLE_MS); };
    const press = () => { down = true; window.clearTimeout(timer); };
    const release = () => { if (!down) return; down = false; later(); };
    view.addEventListener("scroll", later, { passive: true });
    view.addEventListener("pointerdown", press);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    measure();
    return () => {
      view.removeEventListener("scroll", later);
      view.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.clearTimeout(timer);
    };
  }, [count]);
  return { ref, hidden, scrolling };
}
