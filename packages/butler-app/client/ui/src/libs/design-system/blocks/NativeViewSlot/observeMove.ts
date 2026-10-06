/**
 * Calls `onMove` when `element` moves on screen without resizing (a sibling panel opening, a
 * layout shift above it). An IntersectionObserver whose root margin hugs the element's current
 * rect fires as soon as the element leaves that rect; the observer then re-arms on the new rect.
 * Nothing polls: an element that is entirely off-screen waits for the slot's other triggers.
 */
export function observeMove(element: Element, onMove: () => void): { refresh: () => void; disconnect: () => void } {
  let observer: IntersectionObserver | null = null;
  const root = element.ownerDocument.documentElement;

  function disconnect() {
    observer?.disconnect();
    observer = null;
  }

  function arm(rootMargin: string, threshold: number) {
    let first = true;
    observer = new IntersectionObserver(([entry]) => {
      const ratio = entry?.intersectionRatio ?? 0;
      if (first) {
        first = false;
        // Partly off-screen: full overlap is impossible, so watch for a change from today's ratio.
        if (threshold === 1 && ratio > 0 && ratio < 1) {
          disconnect();
          arm(rootMargin, ratio);
        }
        return;
      }
      onMove();
      refresh();
    }, { rootMargin, threshold });
    observer.observe(element);
  }

  function refresh() {
    disconnect();
    if (typeof IntersectionObserver === "undefined") return;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const inset = [rect.top, root.clientWidth - rect.right, root.clientHeight - rect.bottom, rect.left];
    arm(inset.map((value) => `${-Math.floor(value)}px`).join(" "), 1);
  }

  refresh();
  return { refresh, disconnect };
}
