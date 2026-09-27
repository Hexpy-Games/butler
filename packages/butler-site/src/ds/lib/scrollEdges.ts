/**
 * Scroll-edge tracking for the shared scroll-fade mask (scroll-fade.css),
 * forked from the app DS useScrollEdges. Vanilla: server-rendered markup
 * declares data-scroll-fade="x|y" and this mirrors the edges into
 * data-overflowing / data-at-start / data-at-end.
 */
export type ScrollEdgeAxis = "x" | "y";

const EDGE_TOLERANCE_PX = 1;

export function readScrollEdges(element: HTMLElement, axis: ScrollEdgeAxis) {
  const position = Math.abs(axis === "x" ? element.scrollLeft : element.scrollTop);
  const size = axis === "x" ? element.clientWidth : element.clientHeight;
  const total = axis === "x" ? element.scrollWidth : element.scrollHeight;
  const overflowing = total - size > EDGE_TOLERANCE_PX;
  return {
    overflowing,
    atStart: !overflowing || position <= EDGE_TOLERANCE_PX,
    atEnd: !overflowing || position + size >= total - EDGE_TOLERANCE_PX,
  };
}

function write(element: HTMLElement, key: "overflowing" | "atStart" | "atEnd", value: boolean) {
  const next = String(value);
  if (element.dataset[key] !== next) element.dataset[key] = next;
}

/** Tracks one scroller; scroll and resize work is batched into one frame. */
export function observeScrollEdges(element: HTMLElement, axis: ScrollEdgeAxis): () => void {
  let frame = 0;
  const update = () => {
    frame = 0;
    const edges = readScrollEdges(element, axis);
    write(element, "overflowing", edges.overflowing);
    write(element, "atStart", edges.atStart);
    write(element, "atEnd", edges.atEnd);
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(update);
  };
  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(element);
  if (element.firstElementChild) resizeObserver.observe(element.firstElementChild);
  element.addEventListener("scroll", schedule, { passive: true });
  update();
  return () => {
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    element.removeEventListener("scroll", schedule);
  };
}

/** Wires every declared scroller under `root` once. */
export function observeAllScrollEdges(root: ParentNode = document) {
  for (const element of root.querySelectorAll<HTMLElement>("[data-scroll-fade]:not([data-scroll-fade-ready])")) {
    element.dataset.scrollFadeReady = "true";
    observeScrollEdges(element, element.dataset.scrollFade === "x" ? "x" : "y");
  }
}
