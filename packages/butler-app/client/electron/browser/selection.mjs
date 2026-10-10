import { savePickedImages, copyPickedText } from "./selection-actions.mjs";
import { randomUUID } from "node:crypto";
import { isPickShortcut } from "../butler-platform/browser-shortcuts.mjs";

/** DOM content is read in an isolated world, never inserted into the page. */
function elementAt(x, y, documentToken, capture) {
  const element = document.elementFromPoint(x, y);
  if (!element || element === document.documentElement || element === document.body) return null;
  // A crop must not retain a secret field. Reject ancestors containing one too.
  if (element.matches('input,textarea,iframe,[contenteditable="true"]') || element.querySelector('input,textarea,[contenteditable="true"]')) return null;
  const r = element.getBoundingClientRect();
  const clip = box => ({ x: Math.max(0, box.left), y: Math.max(0, box.top),
    width: Math.min(innerWidth, box.right) - Math.max(0, box.left), height: Math.min(innerHeight, box.bottom) - Math.max(0, box.top) });
  const rect = clip(r);
  if (!capture) return rect.width > 0 && rect.height > 0 ? { rect, tag: element.tagName.toLowerCase() } : null;
  // Text ranges avoid a block's empty width; visual media contribute their own boxes.
  const content = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      const parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return NodeFilter.FILTER_REJECT;
      if (node.nodeType === Node.TEXT_NODE) return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      return node.matches("img,svg,canvas,video") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  if (element.matches("img,svg,canvas,video")) content.push(r);
  else while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE) {
      const range = document.createRange(); range.selectNodeContents(node);
      content.push(...range.getClientRects());
    } else content.push(node.getBoundingClientRect());
  }
  const visible = content.filter(box => box.width > 0 && box.height > 0 && box.right > rect.x && box.bottom > rect.y && box.left < r.right && box.top < r.bottom);
  const cropRect = visible.length ? clip({ left: Math.max(r.left, Math.min(...visible.map(box => box.left))),
    top: Math.max(r.top, Math.min(...visible.map(box => box.top))), right: Math.min(r.right, Math.max(...visible.map(box => box.right))),
    bottom: Math.min(r.bottom, Math.max(...visible.map(box => box.bottom))) }) : rect;
  if (rect.width <= 0 || rect.height <= 0) return null;
  const text = element.innerText || element.textContent || element.getAttribute("alt") || "";
  const title = (element.getAttribute("aria-label") || element.getAttribute("alt") || text || element.tagName).trim().split("\n")[0];
  // This isolated-world map lives only for this document. Geometry changes
  // cannot turn a drag of an already picked DOM node into another selection.
  const state = globalThis.__butlerPickNodes ??= { nodes: new Map(), documentToken };
  if (!state.nodes.has(element)) state.nodes.set(element, state.nodes.size + 1);
  return { title, text, tag: element.tagName.toLowerCase(), rect, cropRect, identity: `${state.documentToken}:${state.nodes.get(element)}` };
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
    this.cancelDrag(); this.clearHover(tab);
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
  clearHover(tab) {
    if (tab) tab.pickHover = null; this.hoverInput = null; this.hoverRevision = (this.hoverRevision ?? 0) + 1;
  }
  async read(tab, input, capture = false) {
    const scale = tab.bounds?.scale ?? 1;
    const code = `(${elementAt.toString()})(${JSON.stringify(input.x / scale)},${JSON.stringify(input.y / scale)},${JSON.stringify(randomUUID())},${capture})`;
    return tab.view.webContents.executeJavaScriptInIsolatedWorld(1004, [{ code }]);
  }
  hover(tab, input) {
    this.hoverRevision = (this.hoverRevision ?? 0) + 1;
    this.hoverInput = { tab, input, epoch: tab.epoch, revision: this.hoverRevision };
    if (this.hoverPending) return;
    this.hoverPending = true;
    void this.updateHover().catch(() => this.browser.pointer.inputFailed()).finally(() => { this.hoverPending = false; });
  }
  async updateHover() {
    while (this.hoverInput) {
      const { tab, input, epoch, revision } = this.hoverInput; this.hoverInput = null;
      const result = await this.read(tab, input).catch(() => null);
      if (revision !== this.hoverRevision || !tab.picking || tab.epoch !== epoch || this.browser.activeId !== tab.id) continue;
      tab.pickHover = result ? { rect: result.rect, tag: result.tag } : null;
      this.browser.pointer.sync(tab);
    }
  }
  async hit(tab, input) {
    const epoch = tab.epoch, url = tab.url;
    const result = await this.read(tab, input, true);
    if (!result) return null;
    const scale = tab.bounds?.scale ?? 1;
    const crop = result.cropRect;
    const rect = { x: Math.floor(crop.x * scale), y: Math.floor(crop.y * scale),
      width: Math.ceil((crop.x + crop.width) * scale) - Math.floor(crop.x * scale),
      height: Math.ceil((crop.y + crop.height) * scale) - Math.floor(crop.y * scale) };
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
    if (input.type === "mouseMove") this.hover(tab, input);
    if (input.type === "mouseDown" && input.button === "left") {
      const start = { x: input.x, y: input.y, input, epoch: tab.epoch };
      this.down = start;
      void this.hit(tab, input).then(item => {
        start.item = item; start.ready = true;
        this.settle(tab, start);
      }).catch(() => this.browser.pointer.inputFailed());
    } else if (this.down && ["mouseMove", "mouseUp"].includes(input.type)) {
      const start = this.down;
      start.input = input;
      start.moved ||= Math.hypot(input.x - start.x, input.y - start.y) > 6;
      start.ended = input.type === "mouseUp";
      this.settle(tab, start);
    }
    return true;
  }
  settle(tab, start) {
    if (this.down !== start || !start.ready) return;
    if (!start.item || !tab.picking || tab.epoch !== start.epoch || this.browser.activeId !== tab.id) {
      this.down = null; return;
    }
    if (!start.moved && !start.ended) return;
    this.down = null;
    const prior = tab.selections ?? [], item = start.item;
    const exists = prior.some(p => this.same(p, item));
    tab.selections = exists ? (start.moved ? prior : prior.filter(p => !this.same(p, item))) : [...prior, item];
    this.browser.publish();
    if (start.moved) {
      this.drag(tab, start.input, "start");
      if (start.ended) this.drag(tab, start.input, "end");
    }
  }
  cancelDrag() {
    this.down = null;
    const tab = this.browser.tabs.get(this.dragTab);
    if (tab) this.drag(tab, { x: 0, y: 0 }, "cancel");
    this.dragTab = null;
  }
  same(a, b) { return a.url === b.url && a.identity === b.identity; }
  drag(tab, input, phase) {
    if (phase === "end" || phase === "cancel") this.dragTab = null;
    if (!tab?.selections?.length || !tab.view || tab.view.webContents.isDestroyed()) return;
    const bounds = tab.view.getBounds();
    if (phase === "start") this.dragTab = tab.id;
    this.browser.getWindow()?.webContents.send("butler-browser:element-drag", {
      phase, tab: tab.id, x: bounds.x + input.x, y: bounds.y + input.y,
      ...(phase === "start" ? { elements: this.result(tab, tab.owner.slice(13)).untrusted_content.elements } : {}),
    });
    if (phase === "end" || phase === "cancel") this.browser.sync(tab);
  }
  async command(op, id) {
    const tab = this.browser.tabs.get(id);
    if (!tab || tab.id !== this.browser.activeId) return;
    if (op === "save-image") return savePickedImages(this.browser, tab);
    if (op === "copy-text") return copyPickedText(this.browser, tab);
    if (op === "attach" || op === "scrap") this.browser.getWindow()?.webContents.send("butler-browser:selection-action", { op, elements: this.result(tab, tab.owner.slice(13)).untrusted_content.elements });
    else if (op === "clear") this.clear(id);
    else if (op === "finish") this.mode(id, false);
    else if (op === "cancel-drag") this.cancelDrag();
  }
}
