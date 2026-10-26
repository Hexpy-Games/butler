/**
 * Every capture of a tab's page goes through here, and every attach of a tab's view goes through
 * `attachView`. Electron 44 on macOS wedges a view for good when it is removed, re-added and resized
 * while one of its capturePage calls is in flight: that capture can still return, but no later capture
 * of the view ever settles.
 */
export function capturePage(tab, rect, options = { stayHidden: true }, contents = tab.view.webContents) {
  const pending = contents.capturePage(rect, options);
  const captures = tab.captures ??= new Set();
  captures.add(pending);
  const settled = () => { captures.delete(pending); };
  pending.then(settled, settled);
  return pending;
}

/** Null when no capture of the tab is in flight; otherwise settles once every current one has. */
export function capturesSettled(tab) {
  return tab.captures?.size ? Promise.allSettled([...tab.captures]) : null;
}

/**
 * Puts the tab's view in `win`; `place` sizes it there and `resync` lays the tab out again later.
 * With a capture in flight it depends on whether the page is hidden out of a window:
 * - A hidden page (background throttling on) captures without a window, so it is attached once its
 *   captures settle (the still stands in meanwhile).
 * - A page that stays visible (throttling off, as while media plays) has no compositor out of a
 *   window, so its captures finish only once it is attached again; waiting would keep it out for good.
 *   It is attached at once and keeps its last bounds until they settle, then `place` runs.
 * Returns false while the attach waits.
 */
export function attachView(tab, win, place, resync) {
  if (tab.attached === win) {
    if (!tab.placeHold) place();
    return true;
  }
  const settled = capturesSettled(tab);
  if (settled && tab.view.webContents.getBackgroundThrottling()) {
    tab.attachWait ??= settled.then(() => { tab.attachWait = null; resync(); });
    return false;
  }
  win.contentView.addChildView(tab.view); tab.attached = win;
  const { width, height } = tab.view.getBounds();
  // A view that was never placed shows nothing until it is; it takes its place at once.
  const hold = width && height ? settled?.then(() => {
    if (tab.placeHold !== hold) return;
    tab.placeHold = null;
    if (tab.attached === win && tab.view) place();
  }) ?? null : null;
  tab.placeHold = hold;
  if (!hold) place();
  return true;
}
