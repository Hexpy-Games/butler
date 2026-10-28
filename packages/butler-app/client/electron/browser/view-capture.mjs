/**
 * Every capture of a tab's page goes through here, and every attach of a tab's view goes through
 * `attachView`. Electron 44 on macOS wedges a view for good when it is removed, re-added and resized
 * while one of its capturePage calls is in flight: that capture can still return, but no later capture
 * of the view ever settles.
 */
export function capturePage(tab, rect, options = { stayHidden: true }, contents = tab.view.webContents) {
  const pending = contents.capturePage(rect, options);
  // Each capture keeps how the page stood when it started: hidden out of a window (background
  // throttling on) or visible there (off, as while media plays). The flag can flip while it runs.
  const captures = tab.captures ??= new Map();
  captures.set(pending, contents.getBackgroundThrottling());
  const settled = () => { captures.delete(pending); };
  pending.then(settled, settled);
  return pending;
}

/** Null when no matching capture of the tab is in flight; otherwise settles once each current one has. */
function capturesSettled(tab, match = () => true) {
  const current = [...tab.captures?.entries() ?? []].filter(([, hidden]) => match(hidden)).map(([pending]) => pending);
  return current.length ? Promise.allSettled(current) : null;
}

/**
 * Hide immediately, but keep captures in their source window until they settle. Moving even an
 * unthrottled page to a hidden window can strand its capture, without any intervening resize.
 * Keeping the source attachment also lets a visible-start capture finish while the still stands in.
 */
export function detachView(tab, resync) {
  const win = tab.attached;
  if (!win || !tab.view) return false;
  // Destruction never moves the view to another window: remove it before closing its contents.
  if (!tab.closing) tab.view.setVisible(false);
  const settled = tab.closing ? null : capturesSettled(tab);
  if (settled) {
    const wait = tab.detachWait ?? settled.then(() => {
      if (tab.detachWait !== wait) return;
      tab.detachWait = null;
      if (tab.attached === win && tab.view && detachView(tab, resync)) resync();
    });
    tab.detachWait = wait;
    return false;
  }
  tab.detachWait = null;
  if (!win.isDestroyed()) win.contentView.removeChildView(tab.view);
  tab.attached = null;
  // Immediate detach callers already continue their layout or destruction. Re-entering layout
  // here can try to attach a native view from inside Electron's destruction callback and block it.
  return true;
}

/**
 * Puts the tab's view in `win`, beneath the child at `below` when that is a child index (or on top);
 * `place` sizes it there and `resync` lays the tab out again later.
 * A capture of a page that was hidden out of a window when it started, and still is, finishes
 * without a window; adding the view while it runs strands it. So the view waits for those (the
 * still stands in meanwhile). Any other capture in flight (the page was or now is visible, as while
 * media plays) finishes only once the view is in a window, so waiting would keep the page out for
 * good: the view is attached at once and keeps its last bounds until those captures settle.
 * Returns false while the attach waits.
 */
export function attachView(tab, win, below, place, resync) {
  if (tab.attached === win) {
    tab.detachWait = null;
    tab.view.setVisible(true);
    if (!tab.placeHold) place();
    return true;
  }
  // A move waits in the source window; a same-window return above cancels the detach.
  if (tab.detachWait) return false;
  const hiddenOut = tab.view.webContents.getBackgroundThrottling();
  const hidden = hiddenOut ? capturesSettled(tab, (startedHidden) => startedHidden) : null;
  if (hidden) {
    tab.attachWait ??= hidden.then(() => { tab.attachWait = null; resync(); });
    return false;
  }
  if (below >= 0) win.contentView.addChildView(tab.view, below); else win.contentView.addChildView(tab.view);
  tab.attached = win;
  tab.view.setVisible(true);
  const { width, height } = tab.view.getBounds();
  // A view that was never placed shows nothing until it is; it takes its place at once.
  const settled = width && height ? capturesSettled(tab) : null;
  const hold = settled?.then(() => {
    if (tab.placeHold !== hold) return;
    tab.placeHold = null;
    if (tab.attached === win && tab.view) place();
  }) ?? null;
  tab.placeHold = hold;
  if (!hold) place();
  return true;
}
