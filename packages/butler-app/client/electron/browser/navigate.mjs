/** History navigation and file upload steps: both end the batch's page state. */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
const HISTORY = { back: -1, forward: 1, reload: 0 };
export const NAVIGATION = Object.keys(HISTORY);

/** The approved destination; the navigation guard still checks the request. */
export function navigationTarget(tab, action) {
  const history = tab.view.webContents.navigationHistory, index = history.getActiveIndex() + HISTORY[action];
  if (index < 0 || index >= history.length()) return { reason: "no_history" };
  const url = history.getEntryAtIndex(index)?.url ?? "";
  return { hit: { role: "navigation", name: url, frame: "" }, payment: false, upload: false, submit: false, frame_payment: false, addons: [] };
}

export function dispatchNavigation(tab, action) {
  const contents = tab.view.webContents;
  if (action === "back") contents.navigationHistory.goBack();
  else if (action === "forward") contents.navigationHistory.goForward();
  else contents.reload();
}

/** Click the page's own upload control; the next file chooser it opens (page
 * preload or CDP interception) receives the approved workspace file once.
 * Hidden inputs, labels and custom buttons work alike. */
export function dispatchUpload(tab, path, click) {
  const result = new Promise(resolve => {
    const timer = setTimeout(() => { tab.pendingUpload = null; resolve({ status: "unknown", reason: "no_file_chooser" }); }, 5000);
    tab.pendingUpload = { path, done: value => { clearTimeout(timer); tab.pendingUpload = null; resolve(value); } };
  });
  // A click that fails to send leaves no chooser; the timeout answers it.
  Promise.resolve(click()).catch(() => {});
  return result;
}

/** The page preload's chooser answer: the one approved file, read once. */
export function approvedUpload(upload) {
  try {
    const data = readFileSync(upload.path).toString("base64");
    upload.done({ status: "completed", files: 1 });
    return [{ name: basename(upload.path), type: "", data }];
  } catch {
    upload.done({ status: "unknown", reason: "upload_read_failed" });
    return null;
  }
}
