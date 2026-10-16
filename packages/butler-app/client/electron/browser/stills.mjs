import { maskSecure } from "./capture.mjs";

/** Bounded desktop timeline still; never attached to model context. After a
 * saved card or profile fill, the filled fields are masked like a screenshot. */
export async function stepStill(tab) {
  if (tab.dialog) return undefined;
  if (tab.stills === false || !tab.view || tab.view.webContents.isDestroyed()) { tab.afterCapture?.(); return undefined; }
  const contents = tab.view.webContents;
  let current = true, cancel;
  const ended = new Promise(resolve => { cancel = () => { current = false; resolve(undefined); }; });
  const navigate = details => { if (details.isMainFrame && !details.isSameDocument) cancel(); };
  const dialog = (_event, method) => { if (method === "Page.javascriptDialogOpening") cancel(); };
  contents.on("did-start-navigation", navigate);
  contents.on("render-process-gone", cancel);
  contents.on("destroyed", cancel);
  contents.debugger.on("message", dialog);
  try {
    // A renderer promise or compositor readback can outlive its document.
    // Navigation ends that capture; the next observation owns the new page.
    // A native dialog pauses renderer scripts; fence paint without blocking approval.
    return await Promise.race([captureStill(tab, contents, () => current), ended]);
  } finally {
    current = false;
    contents.removeListener("did-start-navigation", navigate);
    contents.removeListener("render-process-gone", cancel);
    contents.removeListener("destroyed", cancel);
    contents.debugger.removeListener("message", dialog);
  }
}

async function captureStill(tab, contents, current) {
  // Input dispatch can finish before its paint reaches the compositor. Share a
  // post-paint bitmap, so both the timeline and live viewer show the new pixels.
  if (!contents.isLoading()) await contents.executeJavaScriptInIsolatedWorld(9001, [{
    code: "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))",
  }]).catch(() => {});
  if (!current()) return undefined;
  let image = await contents.capturePage(undefined, { stayHidden: true }).catch(() => null);
  if (!current()) return undefined;
  tab.afterCapture?.(image);
  if (image && !image.isEmpty() && tab.vaultFilled) image = await maskSecure(tab, image).catch(() => null);
  if (!current() || !image || image.isEmpty()) return undefined;
  const jpeg = image.resize({ width: 320 }).toJPEG(70);
  return jpeg.length <= 24 * 1024 ? { mime: "image/jpeg", base64: jpeg.toString("base64") } : undefined;
}
