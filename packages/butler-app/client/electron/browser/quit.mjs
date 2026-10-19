// Quit never waits on a page or a peer: a tab can be hung or blocked in a
// dialog, and the Agent can already be gone. Every step has a deadline.
const SAVE_MS = 1_500;
const CLOSE_MS = 3_000;

function bounded(work, until) {
  let timer;
  const deadline = new Promise(done => { timer = setTimeout(done, Math.max(0, until - performance.now())); });
  return Promise.race([Promise.resolve().then(work).catch(() => {}), deadline]).finally(() => clearTimeout(timer));
}

/** Pending visits and restorable tabs, written without asking any page. */
export function saveBrowserForQuit(browser, until = performance.now() + SAVE_MS) {
  return bounded(() => {
    for (const tab of browser.tabs.values()) tab.flushHistory?.({ quitting: true });
    return Promise.all([browser.history?.flush(), browser.flush()]);
  }, until);
}

/** One will-quit close per process: a repeated quit joins it, and closing runs even when saving timed out. */
export function installQuitClose(app, browser) {
  let closing = null, closed = false;
  app.on("will-quit", (event) => {
    if (closed) return;
    event.preventDefault();
    closing ??= (async () => {
      const until = performance.now() + CLOSE_MS;
      await saveBrowserForQuit(browser, Math.min(until, performance.now() + SAVE_MS));
      await bounded(() => browser.dispose(), until);
    })().finally(() => {
      closed = true;
      // Electron ignores a same-tick quit after cancelling will-quit.
      setImmediate(() => app.quit());
    });
  });
}
