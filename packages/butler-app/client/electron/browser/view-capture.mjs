/**
 * Every capture of a tab's page goes through here. Electron 44 on macOS wedges a view for good when
 * it is attached to a window and resized while one of its capturePage calls is in flight: that
 * capture still returns, but no later capture of the view ever settles. Attaching therefore waits
 * for the tab's captures to settle (see `capturesSettled`).
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
