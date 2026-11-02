/** Window presentation changes remeasure the DOM host and reconcile native attachment. */
export function createViewRecovery(browser) {
  let window, listeners = [];
  const dispose = () => {
    if (window && !window.isDestroyed()) for (const [event, listener] of listeners) window.removeListener(event, listener);
    window = null; listeners = [];
  };
  return {
    bind(win) {
      if (window === win) return;
      dispose(); window = win;
      if (!win || win.isDestroyed()) return;
      for (const event of ["focus", "show", "restore", "resize", "move", "enter-full-screen", "leave-full-screen"]) {
        const listener = () => {
          if (browser.disposing || win.isDestroyed()) return;
          browser.layoutRevision = (browser.layoutRevision ?? 0) + 1;
          browser.syncAll(); browser.publish();
        };
        win.on(event, listener); listeners.push([event, listener]);
      }
    },
    dispose,
  };
}

/** A failed renderer/readback uses the existing sad-tab surface until the user reloads. */
export function failTab(browser, tab, stalled = false) {
  if (tab.closing || browser.disposing || browser.tabs.get(tab.id) !== tab) return;
  tab.surfaceStalled ||= stalled;
  tab.status = "crashed";
  browser.detach(tab); browser.publish();
}
