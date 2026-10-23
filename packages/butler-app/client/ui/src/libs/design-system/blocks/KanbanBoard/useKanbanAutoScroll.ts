import { useEffect, type RefObject } from "react";
import { navDropAutoScrollStep } from "../NavDropTarget";

type Axis = "x" | "y";
const OVERFLOW: Record<Axis, "overflowX" | "overflowY"> = { x: "overflowX", y: "overflowY" };
const SCROLLING = /(auto|scroll|overlay)/u;

function canScroll(node: HTMLElement, axis: Axis, step: number, cache: Map<HTMLElement, CSSStyleDeclaration>): boolean {
  const page = node === document.scrollingElement;
  if (!page) {
    let style = cache.get(node);
    if (!style) { style = getComputedStyle(node); cache.set(node, style); }
    if (!SCROLLING.test(style[OVERFLOW[axis]])) return false;
  }
  const [position, size, total] = axis === "x"
    ? [node.scrollLeft, node.clientWidth, node.scrollWidth]
    : [node.scrollTop, page ? window.innerHeight : node.clientHeight, node.scrollHeight];
  return step < 0 ? position > 0 : position + size < total - 1;
}

/** One frame: the innermost container under the point that can scroll toward the edge, per axis. */
function scrollStep(x: number, y: number, cache: Map<HTMLElement, CSSStyleDeclaration>): boolean {
  const chain: HTMLElement[] = [];
  for (let node = document.elementFromPoint(x, y) as HTMLElement | null; node; node = node.parentElement) chain.push(node);
  const page = document.scrollingElement as HTMLElement | null;
  if (page && !chain.includes(page)) chain.push(page);
  let scrolled = false;
  for (const axis of ["x", "y"] as const) {
    for (const node of chain) {
      const rect = node === page ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } : node.getBoundingClientRect();
      const step = axis === "x" ? navDropAutoScrollStep(x, rect.left, rect.right) : navDropAutoScrollStep(y, rect.top, rect.bottom);
      if (step === 0 || !canScroll(node, axis, step, cache)) continue;
      if (axis === "x") node.scrollLeft += step;
      else node.scrollTop += step;
      scrolled = true;
      break;
    }
  }
  return scrolled;
}

/**
 * While a pointer drag runs, scrolls the containers under the pointer when it rests in their 40px
 * edge band: a board's lanes sideways, a lane's cards and the page vertically. Every frame that
 * scrolled calls `onScroll` so the drop target follows the content under the pointer.
 */
export function useKanbanAutoScroll(active: boolean, pointer: RefObject<{ x: number; y: number } | null>, onScroll: () => void) {
  useEffect(() => {
    if (!active) return;
    const cache = new Map<HTMLElement, CSSStyleDeclaration>();
    let frame = requestAnimationFrame(function tick() {
      const point = pointer.current;
      if (point && scrollStep(point.x, point.y, cache)) onScroll();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, pointer, onScroll]);
}
