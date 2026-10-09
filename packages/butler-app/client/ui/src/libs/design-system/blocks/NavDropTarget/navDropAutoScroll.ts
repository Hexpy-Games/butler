import { useCallback, useEffect, useRef, useState } from "react";

/** Edge band (px) where a drag scrolls the list. */
export const NAV_DROP_AUTO_SCROLL_EDGE = 40;
/** Fastest scroll per frame, reached at the very edge. */
const MAX_STEP = 12;

export type NavDropAutoScrollEdge = "start" | "end";

/**
 * Scroll delta for one frame while a drag hovers at `clientY` over a list spanning `top`–`bottom`:
 * 0 outside the edge bands, growing to ±MAX_STEP at the edge itself.
 */
export function navDropAutoScrollStep(clientY: number, top: number, bottom: number, edge = NAV_DROP_AUTO_SCROLL_EDGE): number {
  if (bottom - top <= edge * 2) return 0;
  if (clientY < top + edge) return -Math.ceil(MAX_STEP * Math.min(1, (top + edge - clientY) / edge));
  if (clientY > bottom - edge) return Math.ceil(MAX_STEP * Math.min(1, (clientY - (bottom - edge)) / edge));
  return 0;
}

/**
 * Auto-scroll for drags over a sidebar list (rows or outside payloads such as picked elements and
 * tabs): call `update` from dragover with the scroll container, `stop` on drop, dragleave and dragend.
 * Scrolls once per frame while the pointer stays in a 40px edge band; `edge` drives the visual band
 * (NavDropScope `autoScroll`). Rows never move: only the container scrolls.
 */
export function useNavDropAutoScroll() {
  const [edge, setEdge] = useState<NavDropAutoScrollEdge | null>(null);
  const state = useRef<{ scroller: HTMLElement | null; clientY: number; frame: number }>({ scroller: null, clientY: 0, frame: 0 });

  const stop = useCallback(() => {
    if (state.current.frame) cancelAnimationFrame(state.current.frame);
    state.current.frame = 0;
    state.current.scroller = null;
    setEdge(null);
  }, []);

  const tick = useCallback(() => {
    const { scroller, clientY } = state.current;
    state.current.frame = 0;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const step = navDropAutoScrollStep(clientY, rect.top, rect.bottom);
    const room = step < 0 ? scroller.scrollTop > 0 : scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight;
    if (step === 0 || !room) {
      setEdge(null);
      return;
    }
    scroller.scrollTop += step;
    setEdge(step < 0 ? "start" : "end");
    state.current.frame = requestAnimationFrame(tick);
  }, []);

  const update = useCallback((clientY: number, scroller: HTMLElement) => {
    state.current.scroller = scroller;
    state.current.clientY = clientY;
    if (!state.current.frame) state.current.frame = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => stop, [stop]);
  return { edge, update, stop };
}
