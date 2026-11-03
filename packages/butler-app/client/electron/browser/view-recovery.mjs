import { capturePage } from "./view-capture.mjs";

const PROBE = { x: 0, y: 0, width: 1, height: 1 };

/** A window's return reconciles native attachment and probes the shown page's surface once. */
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
      for (const event of ["focus", "show", "restore"]) {
        const listener = () => {
          if (browser.disposing || win.isDestroyed()) return;
          browser.syncAll();
          // A wedged surface never settles a readback; one tiny probe turns it into the reload surface.
          const tab = browser.tabs.get(browser.activeId);
          if (tab?.attached === win && tab.view?.getVisible() && tab.status !== "crashed") void capturePage(tab, PROBE).catch(() => {});
        };
        win.on(event, listener); listeners.push([event, listener]);
      }
    },
    dispose,
  };
}

/** A gone, hung or wedged page shows the existing sad-tab surface. */
export function failTab(browser, tab, reason) {
  if (tab.closing || browser.disposing || browser.tabs.get(tab.id) !== tab) return;
  if (reason === "unresponsive") tab.unresponsive = true;
  tab.failure = reason;
  tab.status = "crashed";
  browser.detach(tab); browser.publish();
}

/** A hang or slow readback that ends by itself returns the live view; a gone renderer needs a reload. */
export function recoverTab(browser, tab) {
  if (tab.failure !== "unresponsive" && tab.failure !== "stalled") return;
  if (tab.unresponsive || tab.captures?.size || tab.closing || browser.disposing || browser.tabs.get(tab.id) !== tab) return;
  const contents = tab.view?.webContents;
  if (!contents || contents.isDestroyed() || contents.isCrashed()) return;
  tab.failure = null;
  tab.status = contents.isLoading() ? "loading" : "idle";
  browser.sync(tab); browser.publish();
}
