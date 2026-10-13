import type { ScrapSnapshot } from "./browserElements";

export type AppPartSnapshot = ScrapSnapshot & { html: string; crop?: string };

/**
 * A scrap copy of one part of the App's own UI (an answer card, a gallery item) through the page-scrap
 * snapshot pipeline: computed styles inline, images and fonts inlined, shown sandboxed by the 서랍 viewer.
 * The part carries a transient marker only while the desktop copies it. Null on the web client or when the
 * copy cannot be made; the scrap then keeps its picture only.
 */
export async function snapshotAppPart(part: Element | null | undefined): Promise<AppPartSnapshot | null> {
  if (!part || !window.butlerBrowser) return null;
  const target = crypto.randomUUID();
  part.setAttribute("data-butler-snapshot", target);
  try {
    const copy = await window.butlerBrowser.call("app-snapshot", { target }) as AppPartSnapshot | null | undefined;
    return copy && typeof copy.html === "string" ? copy : null;
  } catch {
    return null;
  } finally {
    part.removeAttribute("data-butler-snapshot");
  }
}
