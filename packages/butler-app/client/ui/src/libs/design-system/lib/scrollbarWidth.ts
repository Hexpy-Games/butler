/** Root property: a thin native scrollbar's layout width, `0px` for overlay scrollbars. */
export const SCROLLBAR_WIDTH_PROPERTY = "--scrollbar-width";

const published = new WeakSet<Document>();

/**
 * Measures once per document how much layout width a drawn thin native
 * scrollbar takes and publishes it on the root, so a scroller reserves a lane
 * for an overlay scrollbar only: a classic scrollbar is its own lane. DS
 * scrollers reserve no gutter, so the probe draws a scrollbar (`overflow-y:
 * scroll`) instead of reading a gutter: it reads the width a scroller loses
 * while its content overflows (0 for overlay scrollbars, and for headless
 * Chromium, which draws scrollbars without width). One probe at the first
 * mount of any DS scroller; nothing runs while idle or on scroll.
 */
export function publishScrollbarWidth(element: HTMLElement | null): void {
  const doc = element?.ownerDocument;
  if (!doc?.body || published.has(doc)) return;
  published.add(doc);
  const probe = doc.createElement("div");
  probe.style.cssText =
    "position:absolute;top:0;left:0;width:100px;height:100px;overflow:hidden scroll;scrollbar-width:thin;visibility:hidden;pointer-events:none";
  doc.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  doc.documentElement.style.setProperty(SCROLLBAR_WIDTH_PROPERTY, `${width}px`);
}
