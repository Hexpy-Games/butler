import { shell } from "electron";
import { appendFileSync } from "node:fs";

/**
 * Every desktop open/reveal the App performs goes through here. A harness that sets
 * BUTLER_TEST_SHELL_OPEN_LOG gets one JSONL line ({ action, target }) per request in that file
 * instead of a real Finder/Explorer window or browser on the machine running it.
 */
function recorded(action, target) {
  const log = process.env.BUTLER_TEST_SHELL_OPEN_LOG;
  if (!log) return false;
  appendFileSync(log, `${JSON.stringify({ action, target })}\n`);
  return true;
}

export function openExternal(url, options) {
  return recorded("openExternal", url) ? Promise.resolve() : shell.openExternal(url, options);
}

/** Resolves to "" on success, like shell.openPath. */
export function openPath(path) {
  return recorded("openPath", path) ? Promise.resolve("") : shell.openPath(path);
}

export function showItemInFolder(path) {
  if (!recorded("showItemInFolder", path)) shell.showItemInFolder(path);
}
