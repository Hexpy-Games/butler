/** Root property: a thin native scrollbar's layout width, `0px` for overlay scrollbars. */
export const SCROLLBAR_WIDTH_PROPERTY = "--scrollbar-width";

const published = new WeakSet<Document>();

/**
 * Measures once per document how much layout width a thin native scrollbar
 * takes and publishes it on the root, so a scroller reserves a lane for an
 * overlay scrollbar only: a classic scrollbar is its own lane. The probe is
 * styled like the ScrollArea scroller (a stable gutter on a vertical auto
 * scroller), so it reads the width that scroller actually reserves; headless
 * Chromium with hidden scrollbars reserves the gutter yet gives a forced
 * `overflow: scroll` bar no width. One probe at the first mount; nothing runs
 * while idle or on scroll.
 */
export function publishScrollbarWidth(element: HTMLElement | null): void {
  const doc = element?.ownerDocument;
  if (!doc?.body || published.has(doc)) return;
  published.add(doc);
  const probe = doc.createElement("div");
  probe.style.cssText =
    "position:absolute;top:0;left:0;width:100px;height:100px;overflow:hidden auto;scrollbar-gutter:stable;scrollbar-width:thin;visibility:hidden;pointer-events:none";
  doc.body.append(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  doc.documentElement.style.setProperty(SCROLLBAR_WIDTH_PROPERTY, `${width}px`);
}
