import { SNAPSHOT_SOURCE, snapshotPick } from "./snapshot.mjs";

/** The App's own UI runs the scrap snapshot in its own isolated world; it never shares the page worlds. */
const APP_WORLD = 9003;
const ASSET_LIMIT = 3 * 1024 * 1024, APP_FONT_BUDGET = 3 * 1024 * 1024;
const TARGET = /^[a-z0-9-]{8,64}$/iu;

/**
 * Reads a resource the App UI shows: its own bundle (fonts, icons) and the local gateway's signed files. Nothing
 * from the web: an App part never shows a remote resource directly.
 */
function appAsset(contents) {
  // The App renderer may run on its own scheme (app://butler), whose URL origin is opaque: compare scheme and host.
  const own = (() => { try { const page = new URL(contents.getURL()); return `${page.protocol}//${page.host}`; } catch { return ""; } })();
  return async (url) => {
    try {
      const parsed = new URL(url);
      const loopback = ["http:", "https:"].includes(parsed.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
      if (!loopback && (!own || `${parsed.protocol}//${parsed.host}` !== own)) return null;
      const response = await contents.session.fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > ASSET_LIMIT) return null;
      const body = Buffer.from(await response.arrayBuffer());
      return body.length > ASSET_LIMIT ? null : { type: (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(), body };
    } catch { return null; }
  };
}

/**
 * A scrap copy of one part of the App's UI (an answer card), made by the same pipeline as a page scrap: the
 * part's DOM with computed styles inline, images and fonts inlined, sandboxed by the viewer's CSP. The renderer
 * marks the part with `data-butler-snapshot="<target>"` for the duration of the call. `crop` is the part as it
 * shows on screen (JPEG), for a scrap without its own picture.
 */
export async function snapshotApp(win, target) {
  if (typeof target !== "string" || !TARGET.test(target)) throw new Error("invalid_snapshot_target");
  const contents = win.webContents;
  const scale = contents.getZoomFactor();
  const tab = {
    // The App's one text face (Pretendard Variable, ~2.7 MB inlined) must travel with the copy: a fallback face's
    // wider glyphs re-wrap the card's fixed-width lines. A page scrap keeps the default font budget.
    epoch: 1, url: contents.getURL(), bounds: { scale }, fetchAsset: appAsset(contents), fontBudget: APP_FONT_BUDGET,
    view: { webContents: contents, getBounds: () => { const { width, height } = win.getContentBounds(); return { x: 0, y: 0, width, height }; } },
  };
  const selector = `[data-butler-snapshot="${target}"]`;
  const run = (_path, args) => contents.executeJavaScriptInIsolatedWorld(APP_WORLD, [{ code: `(${SNAPSHOT_SOURCE})(${JSON.stringify({ ...args, selector })})` }]);
  const copy = await snapshotPick({ tab, item: { identity: "" }, frame: { path: [], offset: { x: 0, y: 0 }, clip: null }, run });
  if (!copy) return null;
  const image = await contents.capturePage({ x: Math.floor(copy.x * scale), y: Math.floor(copy.y * scale),
    width: Math.max(1, Math.ceil(copy.width * scale)), height: Math.max(1, Math.ceil(copy.height * scale)) });
  const crop = image.isEmpty() ? undefined : `data:image/jpeg;base64,${image.toJPEG(88).toString("base64")}`;
  return { html: copy.html, width: copy.width, height: copy.height, crop };
}
