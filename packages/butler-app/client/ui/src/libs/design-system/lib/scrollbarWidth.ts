/** Root property: a thin native scrollbar's layout width, `0px` for overlay scrollbars. */
export const SCROLLBAR_WIDTH_PROPERTY = "--scrollbar-width";

const published = new WeakSet<Document>();

/** Fractional: under page zoom a scrollbar's CSS width is not a whole number (11 device px at 130% is 8.46 CSS px). */
function measure(doc: Document) {
  const probe = doc.createElement("div");
  probe.style.cssText =
    "position:absolute;top:0;left:0;width:100px;height:100px;overflow:hidden scroll;scrollbar-width:thin;visibility:hidden;pointer-events:none";
  const content = doc.createElement("div");
  probe.append(content);
  doc.body.append(probe);
  const width = probe.getBoundingClientRect().width - content.getBoundingClientRect().width;
  probe.remove();
  doc.documentElement.style.setProperty(SCROLLBAR_WIDTH_PROPERTY, `${width}px`);
}

/** Measures again whenever the device pixel ratio changes: page zoom (App text size) scales a classic scrollbar's CSS width. */
function remeasureOnZoom(doc: Document) {
  const view = doc.defaultView;
  if (!view?.matchMedia) return;
  const query = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`);
  query.addEventListener("change", () => {
    measure(doc);
    remeasureOnZoom(doc);
  }, { once: true });
}

/** Per scroller, on its frame (the parent): the width its own scrollbar takes from its content box now (`0px` when none is drawn or it overlays). */
export const DRAWN_SCROLLBAR_PROPERTY = "--scroll-area-drawn-scrollbar";

/** Runs from the observer, after layout: it forces no layout of its own. */
function writeDrawnScrollbar(scroller: HTMLElement, frame: HTMLElement) {
  const style = getComputedStyle(scroller);
  const borders = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
  const next = `${Math.max(0, scroller.offsetWidth - borders - scroller.clientWidth)}px`;
  if (frame.style.getPropertyValue(DRAWN_SCROLLBAR_PROPERTY) !== next) frame.style.setProperty(DRAWN_SCROLLBAR_PROPERTY, next);
}

/**
 * Ref callback: publishes the width this scroller's scrollbar actually takes
 * as `--scroll-area-drawn-scrollbar` on its frame, so the lane is never
 * narrower than that scrollbar and the content gives back exactly that width.
 * The document-wide `--scrollbar-width` says how wide a classic scrollbar
 * would be; it is measured once and can disagree with the scrollbar a scroller
 * draws (macOS switches between overlay and classic scrollbars with the
 * pointing device), and giving that width back while an overlay scrollbar
 * takes none pushed the content past the column. A ResizeObserver on the
 * scroller's content box reports once on mount and again when its scrollbar
 * appears, goes or changes width, each time before that frame paints;
 * nothing runs while idle or on scroll.
 */
export function trackDrawnScrollbar(element: HTMLElement | null): (() => void) | void {
  const frame = element?.parentElement;
  if (!element || !frame || typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver(() => writeDrawnScrollbar(element, frame));
  observer.observe(element);
  return () => observer.disconnect();
}

/**
 * Measures how much layout width a drawn thin native scrollbar takes and
 * publishes it on the root, so a scroller reserves a lane for an overlay
 * scrollbar only: a classic scrollbar is its own lane. DS scrollers reserve
 * no gutter, so the probe draws a scrollbar (`overflow-y: scroll`) instead of
 * reading a gutter: it reads the width a scroller loses while its content
 * overflows (0 for overlay scrollbars, and for headless Chromium, which draws
 * scrollbars without width). One probe at the first mount of any DS
 * scroller, and one more on each zoom change (a classic scrollbar keeps its
 * device size, so its CSS width shrinks as the page zooms in); nothing runs
 * while idle or on scroll.
 */
export function publishScrollbarWidth(element: HTMLElement | null): void {
  const doc = element?.ownerDocument;
  if (!doc?.body || published.has(doc)) return;
  published.add(doc);
  measure(doc);
  remeasureOnZoom(doc);
}
