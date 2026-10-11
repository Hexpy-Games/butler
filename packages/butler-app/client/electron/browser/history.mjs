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
  const begin = (_event, _url, inPlace, mainFrame) => {
    if (!mainFrame) return;
    intent = { private: privateMode(), background: background(),
      butlerDriven: tab.owner !== "mine" && tab.holder === "agent" && Boolean(tab.busy || tabInUse(browser, tab)),
      transition: tab.navigationIntent?.op === "navigate" ? "typed" : ["back", "forward"].includes(tab.navigationIntent?.op) ? "forward_back" : tab.navigationIntent?.op === "reload" ? "reload" : "link" };
    tab.navigationIntent = null;
    if (!inPlace) tab.favicon = "";
  };
  const commit = (url, inPage) => {
    const state = intent ?? { private: privateMode(), background: background(), butlerDriven: tab.owner !== "mine" && tab.holder === "agent" && Boolean(tab.busy || tabInUse(browser, tab)), transition: "link" };
    if (state.private || privateMode() || tab.preview) return;
    let parsed; try { parsed = new URL(url); } catch { return; }
    if (!["http:", "https:"].includes(parsed.protocol) || ["/__p/", "/__o/"].some(prefix => parsed.pathname.startsWith(prefix))) return;
    if (state.background && !tab.owner.startsWith("conversation:")) return;
    const visit = { url: parsed.href, title: parsed.href, favicon: "", visitedAt: new Date().toISOString(),
      transition: state.transition, tabKind: tab.owner === "mine" ? "mine" : "conversation", conversationId: tab.owner.startsWith("conversation:") ? tab.owner.slice(13) : undefined,
      butlerDriven: state.butlerDriven, background: state.background, source: "butler" };
    browser.history?.add(visit);
    pending.push(visit);
    intent = null;
    if (inPage) queueMicrotask(() => void drain());
  };
  async function drain() {
    if (privateMode()) { pending = []; return; }
    if (!pending.length) return;
    const visits = pending; pending = [];
    let favicon = tab.favicon || "", currentUrl = "", title = "";
    try {
      currentUrl = contents.getURL(); title = contents.getTitle();
      const found = await contents.executeJavaScript("document.querySelector('link[rel~=icon]')?.href||''");
      if (typeof found === "string" && /^https?:/u.test(found)) favicon = found;
    } catch { /* A closed or superseded page still has its committed visit. */ }
    if (privateMode()) return;
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
