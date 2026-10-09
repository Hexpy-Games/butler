import { randomUUID } from "node:crypto";
import { isPickShortcut } from "../butler-platform/browser-shortcuts.mjs";

/** DOM content is read in an isolated world, never inserted into the page. */
function elementAt(x, y, documentToken) {
  const element = document.elementFromPoint(x, y);
  if (!element || element === document.documentElement || element === document.body) return null;
  // A crop must not retain a secret field. Reject ancestors containing one too.
  if (element.matches('input,textarea,iframe,[contenteditable="true"]') || element.querySelector('input,textarea,[contenteditable="true"]')) return null;
  const r = element.getBoundingClientRect();
  const rect = { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(innerWidth, r.right) - Math.max(0, r.x), height: Math.min(innerHeight, r.bottom) - Math.max(0, r.y) };
  if (rect.width <= 0 || rect.height <= 0) return null;
  const text = element.innerText || element.textContent || element.getAttribute("alt") || "";
  const title = (element.getAttribute("aria-label") || element.getAttribute("alt") || text || element.tagName).trim().split("\n")[0];
  // This isolated-world map lives only for this document. Geometry changes
  // cannot turn a drag of an already picked DOM node into another selection.
  const state = globalThis.__butlerPickNodes ??= { nodes: new Map(), documentToken };
  if (!state.nodes.has(element)) state.nodes.set(element, state.nodes.size + 1);
  return { title, text, tag: element.tagName.toLowerCase(), rect, identity: `${state.documentToken}:${state.nodes.get(element)}` };
}
export class BrowserSelection {
  constructor(browser) { this.browser = browser; }
  shortcut(input) {
    if (!isPickShortcut(input)) return false;
    this.mode(this.browser.activeId, true); return true;
  }
  mode(id, value) {
    const tab = this.browser.tabs.get(id);
    if (!tab?.url || !tab.view) return;
    this.chrome = null;
    if (value && !this.browser.pointer.acceptInput(tab, true)) return;
    tab.picking = value === true;
    this.down = null;
    this.browser.publish();
    if (tab.picking) this.browser.pointer.view?.webContents.focus();
  }
  clear(id) {
    const tab = this.browser.tabs.get(id); if (!tab) return;
    tab.selections = []; this.browser.publish();
  }
  result(tab, session) {
    const elements = (tab.selections ?? []).map(item => {
      const { ref, ...data } = item;
      // A move/navigation invalidates actable refs, without destroying the saved picks.
      return { ...data, ...(ref && ref.owner === `conversation:${session}` && ref.epoch === tab.epoch ? { ref: ref.id, observation: ref.observation } : {}) };
    });
    return { status: "ok", tab: tab.id, untrusted_content: { kind: "web_page_data", elements } };
  }
  async hit(tab, input) {
    const epoch = tab.epoch, url = tab.url;
    const scale = tab.bounds?.scale ?? 1;
    const code = `(${elementAt.toString()})(${JSON.stringify(input.x / scale)},${JSON.stringify(input.y / scale)},${JSON.stringify(randomUUID())})`;
    const result = await tab.view.webContents.executeJavaScriptInIsolatedWorld(1004, [{ code }]);
    if (!result) return null;
    const rect = Object.fromEntries(Object.entries(result.rect).map(([key, value]) => [key, Math.round(value * scale)]));
    const image = await tab.view.webContents.capturePage(rect, { stayHidden: true });
    if (image.isEmpty()) return null;
    if (!this.browser.tabs.has(tab.id) || tab.epoch !== epoch || tab.url !== url) return null;
    const node = tab.observation?.nodes?.find(node => node.rect && Math.abs(node.rect.x - result.rect.x) < 1 && Math.abs(node.rect.y - result.rect.y) < 1);
    return { ...result, id: randomUUID(), tab: tab.id, url, site: new URL(url).host,
      crop: `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`, capturedAt: new Date().toISOString(),
      ...(node ? { ref: { id: node.ref, observation: tab.observation.obs, epoch: tab.epoch, owner: tab.owner } } : {}) };
  }
  mouse(tab, input) {
    if (!tab?.picking || !["mouseDown", "mouseMove", "mouseUp"].includes(input.type)) return false;
    if (input.type === "mouseDown" && input.button === "left") {
      this.down = { x: input.x, y: input.y, item: this.hit(tab, input).catch(() => null) };
    } else if (input.type === "mouseMove" && this.down && Math.hypot(input.x - this.down.x, input.y - this.down.y) > 6) {
      const start = this.down; this.down = null;
      void start.item.then(item => {
        if (!item || !tab.picking) return;
        if (!(tab.selections ?? []).some(p => this.same(p, item))) tab.selections = [...(tab.selections ?? []), item];
        this.browser.publish(); this.drag(tab, input, "start");
      });
    } else if (input.type === "mouseUp" && this.down) {
      const start = this.down; this.down = null;
      void start.item.then(item => {
        if (!item || !tab.picking) return;
        const prior = tab.selections ?? [];
        tab.selections = prior.some(p => this.same(p, item)) ? prior.filter(p => !this.same(p, item)) : [...prior, item];
        this.browser.publish();
      });
    }
    return true;
  }
  same(a, b) { return a.url === b.url && a.identity === b.identity; }
  drag(tab, input, phase) {
    if (!tab?.selections?.length) return;
    const bounds = tab.view.getBounds();
    if (phase === "start") this.dragTab = tab.id;
    this.browser.getWindow()?.webContents.send("butler-browser:element-drag", {
      phase, tab: tab.id, x: bounds.x + input.x, y: bounds.y + input.y,
      ...(phase === "start" ? { elements: this.result(tab, tab.owner.slice(13)).untrusted_content.elements } : {}),
    });
    if (phase === "end" || phase === "cancel") this.dragTab = null;
  }
  command(op, id) {
    const tab = this.browser.tabs.get(id);
    if (!tab || tab.id !== this.browser.activeId) return;
    if (op === "attach" || op === "scrap") this.browser.getWindow()?.webContents.send("butler-browser:selection-action", { op, elements: this.result(tab, tab.owner.slice(13)).untrusted_content.elements });
    else if (op === "clear") this.clear(id);
    else if (op === "finish") this.mode(id, false);
    else if (op === "cancel-drag") this.dragTab = null;
  }
}
