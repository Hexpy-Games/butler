import { tabInUse } from "./usage.mjs";
/** Change-driven visit batches. The future private-mode owner supplies this hook. */
export function createVisitQueue(send) {
  const pending = [];
  let flushing = null, scheduled = false;
  async function flush() {
    if (flushing) { await flushing.catch(() => {}); if (pending.length) return flush(); return; }
    if (!pending.length) return;
    const batch = pending.splice(0, 100);
    let saved = false;
    flushing = Promise.resolve().then(() => send(batch));
    try { await flushing; saved = true; }
    catch { pending.unshift(...batch); console.error("[browser] history visit batch could not be saved"); }
    finally { flushing = null; }
    if (saved && pending.length) await flush();
  }
  return { flush, add(visit) {
    pending.push(visit);
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => { scheduled = false; void flush(); });
    }
  } };
}
export function wireHistory(browser, tab) {
  const contents = tab.view.webContents;
  let intent, pending = [];
  const background = () => { const win = browser.getWindow(); return !win || !win.isVisible(); };
  const privateMode = () => browser.privateMode === true || tab.privateMode === true;
  const begin = (_event, _url, _inPlace, mainFrame) => {
    if (!mainFrame) return;
    intent = { private: privateMode(), background: background(),
      butlerDriven: tab.owner !== "mine" && tab.holder === "agent" && Boolean(tab.busy || tabInUse(browser, tab)),
      transition: tab.navigationIntent?.op === "navigate" ? "typed" : ["back", "forward"].includes(tab.navigationIntent?.op) ? "forward_back" : tab.navigationIntent?.op === "reload" ? "reload" : "link" };
    tab.navigationIntent = null;
  };
  const commit = (url, inPage) => {
    const state = intent ?? { private: privateMode(), background: background(), butlerDriven: tab.owner !== "mine" && tab.holder === "agent" && Boolean(tab.busy || tabInUse(browser, tab)), transition: "link" };
    if (state.private || privateMode() || tab.preview) return;
    let parsed; try { parsed = new URL(url); } catch { return; }
    if (!["http:", "https:"].includes(parsed.protocol) || ["/__p/", "/__o/"].some(prefix => parsed.pathname.startsWith(prefix))) return;
    if (state.background && !tab.owner.startsWith("conversation:")) return;
    const visit = { url: parsed.href, title: parsed.href, favicon: "", visitedAt: new Date().toISOString(),
      transition: inPage && state.transition === "link" ? "same_document" : state.transition, tabKind: tab.owner === "mine" ? "mine" : "conversation", conversationId: tab.owner.startsWith("conversation:") ? tab.owner.slice(13) : undefined,
      butlerDriven: state.butlerDriven, background: state.background, source: "butler" };
    browser.history?.add(visit);
    pending.push(visit);
    intent = null;
    if (inPage) queueMicrotask(() => void drain());
  };
  /** Metadata for committed visits. On quit the page is never asked: it may be hung or in a dialog. */
  async function drain({ quitting = false } = {}) {
    if (privateMode()) { pending = []; return; }
    if (!pending.length) return;
    // The tab's icon counts once this document has reported or confirmed it (tab-events.mjs).
    let favicon = tab.documentIcon === false ? "" : tab.favicon || "";
    if (!quitting) {
      try {
        const found = await contents.executeJavaScript("document.querySelector('link[rel~=icon]')?.href||''");
        if (typeof found === "string" && /^https?:/u.test(found)) favicon = found;
      } catch { /* A closed or superseded page still has its committed visit. */ }
    }
    // Visits stay pending through the lookup, so a quit meanwhile still writes them.
    const visits = pending; pending = [];
    if (privateMode() || !visits.length) return;
    let currentUrl = "", title = "";
    try { currentUrl = contents.getURL(); title = contents.getTitle(); } catch { /* Destroyed: committed visits keep their URL title. */ }
    for (const visit of visits) {
      if (visit.url === currentUrl) { visit.title = title || visit.url; visit.favicon = favicon; }
      browser.history?.add({ ...visit, metadataOnly: true });
    }
  }
  contents.on("did-start-navigation", begin);
  contents.on("did-navigate", (_event, url) => commit(url, false));
  contents.on("did-navigate-in-page", (_event, url, mainFrame) => { if (mainFrame) commit(url, true); });
  contents.on("did-stop-loading", () => void drain());
  tab.flushHistory = drain;
}
