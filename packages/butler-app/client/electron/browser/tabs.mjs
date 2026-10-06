import { WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { addressUrl, browsingEnabled, createLossBreaker, webUrl } from "./policy.mjs";
import { createTabRestore } from "./restore.mjs";
import { protectPartition, wireTab } from "./tab-events.mjs";

/** One registry per App; no web view before Browser activation. */
class UserBrowser {
  tabs = new Map();
  profiles = new Set();
  activeId = null;
  opened = false;
  areaVisible = false;
  nativeCovers = 0;
  initialization = null;
  metadataTimer = null;

  constructor(app, getWindow) {
    this.getWindow = getWindow;
    this.breaker = createLossBreaker(() => this.trip());
    this.restore = createTabRestore(join(app.getPath("userData"), "browser"), () =>
      [...this.tabs.values()].filter((tab) => tab.owner === "mine").map((tab) => tab.url));
    app.on("child-process-gone", (_event, detail) => {
      if (detail.type === "GPU" && detail.reason !== "clean-exit") this.breaker.loss(this.tabs.size > 0);
    });
  }
  enabled() { return browsingEnabled() && !this.breaker.tripped; }
  snapshot() {
    return { enabled: this.enabled(), blocked: this.breaker.tripped, activeId: this.activeId, nativeCovered: this.nativeCovers > 0,
      tabs: [...this.tabs.values()].map(({ view: _view, attached: _attached, bounds: _bounds, covered: _covered, capture: _capture, still: _still, ...tab }) => tab) };
  }
  publish() {
    const win = this.getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("butler-browser:state", this.snapshot());
  }
  trip() {
    for (const tab of this.tabs.values()) {
      this.detach(tab);
      tab.view?.webContents.close({ waitForBeforeUnload: false });
      tab.view = null;
      tab.status = "crashed";
    }
    this.publish();
  }
  detach(tab) {
    if (tab?.attached && tab.view) {
      void this.capture(tab);
      if (!tab.attached.isDestroyed()) tab.attached.contentView.removeChildView(tab.view);
      tab.attached = null;
    }
  }
  sync(tab) {
    const win = this.getWindow();
    const visible = win && !win.isDestroyed() && win.isVisible() && this.areaVisible && tab.id === this.activeId &&
      tab.bounds?.visible && !tab.covered && this.nativeCovers === 0 && tab.status !== "crashed";
    if (!visible || !tab.view) { this.detach(tab); return; }
    if (tab.attached !== win) { this.detach(tab); win.contentView.addChildView(tab.view); tab.attached = win; }
    const { x, y, width, height } = tab.bounds;
    tab.view.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
  }
  async capture(tab) {
    if (!tab.view || tab.view.webContents.isDestroyed() || tab.status === "crashed") return tab.still;
    if (tab.capture) return tab.capture;
    tab.capture = tab.view.webContents.capturePage(undefined, { stayHidden: true }).then((image) => {
      if (!image.isEmpty()) tab.still = `data:image/jpeg;base64,${image.toJPEG(75).toString("base64")}`;
      return tab.still;
    }).catch(() => tab.still).finally(() => { tab.capture = null; });
    return tab.capture;
  }
  update(tab) {
    if (!tab.view || tab.view.webContents.isDestroyed() || tab.status === "crashed") return;
    const contents = tab.view.webContents;
    const url = webUrl(contents.getURL());
    if (url && url !== tab.url) { tab.url = url; if (tab.owner === "mine") this.restore.changed(); }
    tab.title = contents.getTitle();
    tab.status = contents.isLoading() ? "loading" : "idle";
    tab.canBack = contents.navigationHistory.canGoBack();
    tab.canForward = contents.navigationHistory.canGoForward();
    if (!this.metadataTimer) this.metadataTimer = setTimeout(() => { this.metadataTimer = null; this.publish(); }, 50);
  }
  nativeCover() {
    this.nativeCovers += 1;
    this.publish();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.nativeCovers -= 1;
      this.publish();
      this.syncAll();
    };
  }
  materialize(tab) {
    if (tab.view || !this.enabled()) return;
    const partition = tab.owner === "mine" ? "persist:butler-web" : `butler-conv-${tab.owner.slice(13)}`;
    if (!this.profiles.has(partition)) {
      protectPartition(partition, () => this.nativeCover()); this.profiles.add(partition);
    }
    tab.view = new WebContentsView({ webPreferences: {
      partition, contextIsolation: true, nodeIntegration: false, sandbox: true, navigateOnDragDrop: false,
    } });
    wireTab(tab, { update: (item) => this.update(item), capture: (item) => this.capture(item),
      detach: (item) => this.detach(item), publish: () => this.publish(), nativeCover: () => this.nativeCover(),
      window: this.getWindow, shortcut: (input) => this.shortcut(input),
      popup: (source, url) => this.create({ owner: source.owner, url }, false) });
    if (tab.url) void tab.view.webContents.loadURL(tab.url).catch(() => {});
  }
  create(input = {}, activateTab = true) {
    if (!this.enabled()) throw new Error("browsing_disabled");
    const owner = input.owner ?? "mine";
    if (owner !== "mine" && !/^conversation:[a-zA-Z0-9_-]{1,128}$/u.test(owner)) throw new Error("invalid_owner");
    const url = input.url ? webUrl(input.url) : "";
    if (input.url && !url) throw new Error("blocked_protocol");
    const tab = { id: randomUUID(), owner, url, title: "", favicon: "", status: "idle", canBack: false, canForward: false,
      still: "", view: null, attached: null, bounds: null, covered: false, capture: null };
    this.tabs.set(tab.id, tab);
    if (owner === "mine") this.restore.changed();
    if (activateTab) this.activate(tab.id);
    this.publish();
    return tab.id;
  }
  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.activeId && this.activeId !== id) this.detach(this.tabs.get(this.activeId));
    this.activeId = id;
    this.materialize(tab);
    this.sync(tab);
    this.publish();
  }
  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.detach(tab);
    tab.view?.webContents.close({ waitForBeforeUnload: false });
    this.tabs.delete(id);
    if (tab.owner === "mine") this.restore.changed();
    if (this.activeId === id) {
      this.activeId = null;
      const next = [...this.tabs.keys()].at(-1);
      if (next) this.activate(next);
    }
    this.publish();
  }
  shortcut(input) {
    if (!this.areaVisible || input.type !== "keyDown") return false;
    const command = input.meta || input.control;
    const key = input.key.toLowerCase();
    if (command && key === "l") {
      this.getWindow()?.webContents.focus(); this.getWindow()?.webContents.send("butler-browser:address");
    } else if (command && key === "t") { if (this.enabled()) this.create(); }
    else if (command && key === "w") { if (this.activeId) this.close(this.activeId); }
    else if ((input.alt && ["arrowleft", "arrowright"].includes(key)) || (command && ["[", "]"].includes(key))) {
      if (this.enabled() && this.activeId) this.commandTab(key === "arrowleft" || key === "[" ? "back" : "forward", this.activeId);
    } else return false;
    return true;
  }
  commandTab(op, id, value) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error("unknown_tab");
    if (op === "bounds") {
      if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width < 0 || value.height < 0) throw new Error("invalid_bounds");
      tab.bounds = value; this.sync(tab); return;
    }
    if (op === "covered") { tab.covered = value === true; this.sync(tab); return; }
    if (op === "still") return this.capture(tab);
    if (!this.enabled()) throw new Error("browsing_disabled");
    this.materialize(tab);
    const contents = tab.view.webContents;
    if (op === "navigate") {
      const url = addressUrl(value);
      if (url) {
        tab.status = "loading"; tab.url = url;
        if (tab.owner === "mine") this.restore.changed();
        void contents.loadURL(url).catch(() => {});
      }
    } else if (op === "reload") { tab.status = "loading"; contents.reload(); }
    else if (op === "stop") contents.stop();
    else if (op === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (op === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (op === "focus") contents.focus();
    this.sync(tab); this.publish();
  }
  async open() {
    this.areaVisible = true;
    if (!this.opened) {
      this.initialization ??= this.restore.read().then((urls) => {
        if (this.enabled()) for (const url of urls) this.create({ url }, false);
        this.opened = true;
      });
      await this.initialization;
    }
    const id = this.activeId ?? [...this.tabs.keys()][0];
    if (id) this.activate(id);
    this.publish(); return this.snapshot();
  }
  move({ tabId, toGroupId, index }) {
    const tab = this.tabs.get(tabId);
    if (!tab || toGroupId !== tab.owner || !Number.isInteger(index)) throw new Error("invalid_move");
    const ordered = [...this.tabs.values()].filter((item) => item.id !== tabId);
    const peers = ordered.filter((item) => item.owner === tab.owner);
    const before = peers[Math.max(0, index)];
    ordered.splice(before ? ordered.indexOf(before) : ordered.length, 0, tab);
    this.tabs.clear(); for (const item of ordered) this.tabs.set(item.id, item);
    if (tab.owner === "mine") this.restore.changed(); this.publish();
  }
  hide() { this.areaVisible = false; for (const tab of this.tabs.values()) this.detach(tab); }
  syncAll() { for (const tab of this.tabs.values()) this.sync(tab); }
  flush() { return this.restore.flush(); }
}

export function createUserBrowser(app, getWindow) { return new UserBrowser(app, getWindow); }
