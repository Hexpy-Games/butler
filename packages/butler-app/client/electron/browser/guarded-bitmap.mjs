import { capturePage } from "./view-capture.mjs";

/** A private capture cannot outlive its document or block on a native dialog. */
export async function guardedCapture(tab, task, notifyUnavailable = true) {
  if (tab.dialog) return undefined;
  if (!tab.view || tab.view.webContents.isDestroyed()) { if (notifyUnavailable) tab.afterCapture?.(); return undefined; }
  const contents = tab.view.webContents;
  const dbg = contents.debugger;
  // EventEmitter cleanup remains valid after Electron destroys the native wrapper.
  const removeListener = contents.removeListener.bind(contents);
  let current = true, cancel;
  const ended = new Promise(resolve => { cancel = () => { current = false; resolve(undefined); }; });
  const navigate = details => { if (details.isMainFrame && !details.isSameDocument) cancel(); };
  const dialog = (_event, method) => { if (method === "Page.javascriptDialogOpening") cancel(); };
  contents.on("did-start-navigation", navigate);
  contents.on("render-process-gone", cancel);
  contents.on("destroyed", cancel);
  dbg.on("message", dialog);
  const dialogWaiters = tab.dialogWaiters ??= new Set();
  dialogWaiters.add(cancel);
  try {
    // A renderer promise or compositor readback can outlive its document.
    // Navigation ends that capture; the next observation owns the new page.
    // A native dialog pauses renderer scripts; fence paint without blocking approval.
    return await Promise.race([task(contents, () => current), ended]);
  } catch {
    return undefined; // Private evidence never changes the action/observation outcome.
  } finally {
    current = false;
    removeListener("did-start-navigation", navigate);
    removeListener("render-process-gone", cancel);
    removeListener("destroyed", cancel);
    dbg.removeListener("message", dialog);
    dialogWaiters.delete(cancel);
  }
}

export async function settleStill(tab) {
  return guardedCapture(tab, async (contents, current) => {
    if (!contents.isLoading()) await contents.executeJavaScriptInIsolatedWorld(9001, [{
      code: "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))",
    }]).catch(() => {});
    return current();
  }, false);
}

export async function settledBitmap(tab, contents, current, beforeCapture, settled = false) {
  // Input dispatch can finish before paint reaches the compositor.
  if (!settled && !contents.isLoading()) await contents.executeJavaScriptInIsolatedWorld(9001, [{
    code: "new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))",
  }]).catch(() => {});
  if (!current()) return undefined;
  await beforeCapture?.();
  if (!current()) return undefined;
  const image = await capturePage(tab, undefined, undefined, contents).catch(() => null);
  if (!current()) return undefined;
  tab.afterCapture?.(image);
  return image && !image.isEmpty() ? image : undefined;
}
