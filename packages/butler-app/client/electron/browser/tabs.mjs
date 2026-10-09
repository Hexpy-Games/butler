import { WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachNativeWorlds } from "./native-worlds.mjs";
import { addressUrl, browsingEnabled, createLossBreaker, webUrl } from "./policy.mjs";
import { createTabRestore } from "./restore.mjs";
import { backgroundTab, controlTab, emulation, wireAgentTab, executeBrowser, openAgentPopup, viewedTab } from "./agent.mjs";
import { protectPartition, wireTab } from "./tab-events.mjs";

/** One registry per App; no web view before Browser activation. */
class UserBrowser {
  tabs = new Map();
  profiles = new Set();
  conversationPartitions = new Map();
  stillPreferences = new Map();
  activeId = null;
  opened = false;
  areaVisible = false;
  keyboardFocused = false;
  areaOwner = "mine";
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
    return { enabled: this.enabled(), blocked: this.breaker.tripped, activeId: this.activeId, nativeCovered: this.nativeCovers > 0, focusRequest: this.focusRequest,
      tabs: [...this.tabs.values()].map(tab => ({ id: tab.id, owner: tab.owner, url: tab.url, title: tab.title, favicon: tab.favicon, status: tab.status, canBack: tab.canBack, canForward: tab.canForward, agent: tab.agent, profile: tab.profile, epoch: tab.epoch, holder: tab.holder, sticky: tab.sticky, waiting: tab.waiting, busy: tab.busy, stills: this.stillPreferences.get(tab.owner) !== false })) };
  }
  publish() {
    this.onState?.(this.snapshot());
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
    if (!visible || !tab.view) { this.detach(tab); backgroundTab(this, tab); return; }
    viewedTab(this, tab, true);
    if (tab.attached !== win) { this.detach(tab); win.contentView.addChildView(tab.view); tab.attached = win; }
    const { x, y, width, height } = tab.bounds;
    tab.view.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
    tab.view.setBorderRadius(Math.max(0, Math.round(tab.bounds.radius ?? 0)));
    emulation(tab);
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
    const partition = tab.partition;
    if (!this.profiles.has(partition)) {
      protectPartition(partition, () => this.nativeCover()); this.profiles.add(partition);
    }
    tab.view = new WebContentsView({ webPreferences: {
      ...(tab.profile === "signed_out" ? {preload:fileURLToPath(new URL("./frame-preload.cjs",import.meta.url)),nodeIntegrationInSubFrames:true} : {}),
      partition, webgl: !tab.agent, contextIsolation: true, nodeIntegration: false, sandbox: true, navigateOnDragDrop: false,
    } });
    tab.session = tab.view.webContents.session;
    if(tab.profile === "signed_out")attachNativeWorlds(tab);
    wireTab(tab, { update: (item) => this.update(item), capture: (item) => this.capture(item),
      detach: (item) => this.detach(item), publish: () => this.publish(), nativeCover: () => this.nativeCover(),
      window: this.getWindow, shortcut: (input) => this.shortcut(input, true),
      popup: (source, url) => void this.popup(source, url) });
    if (tab.agent) wireAgentTab(this, tab);
    if (tab.url && !tab.agent) void tab.view.webContents.loadURL(tab.url).catch(() => {});
  }
  async popup(source, url) {
    if (source.agent && source.owner.startsWith("conversation:")) {
      await openAgentPopup(this, source, url); return;
    }
    const id = this.create({ owner: source.owner, url, agent: source.agent, policy: source.policy, partition: source.partition, profile: source.profile }, false);
    const popup=this.tabs.get(id);
    this.materialize(popup);
    if (popup.agent) {backgroundTab(this,popup);await popup.view.webContents.loadURL(url).catch(()=>{});}
  }
  create(input = {}, activateTab = true) {
    if (!this.enabled()) throw new Error("browsing_disabled");
    const owner = input.owner ?? "mine";
    if (owner !== "mine" && !/^conversation:[a-zA-Z0-9_-]{1,128}$/u.test(owner)) throw new Error("invalid_owner");
    if(this.tabs.size>=36) throw new Error("tab_budget_exhausted");
    const url = input.url ? webUrl(input.url) : "";
    if (input.url && !url) throw new Error("blocked_protocol");
    if (owner === "mine" && [...this.tabs.values()].filter(tab => tab.owner === "mine").length >= 30) throw new Error("tab_budget_exhausted");
    const output = url && new URL(url).hostname === "127.0.0.1" && new URL(url).pathname.startsWith("/__o/");
    const profile = input.profile ?? (input.agent || output ? "signed_out" : "signed_in");
    if(input.agent===true) {
      const agents=[...this.tabs.values()].filter(tab=>tab.agent || tab.driven);
      if(agents.length>=6 || agents.filter(tab=>tab.owner===owner).length>=3) throw new Error("tab_budget_exhausted");
    }
    if (profile === "signed_out" && !this.conversationPartitions.has(owner)) this.conversationPartitions.set(owner, `butler-conv-${randomUUID()}`);
    const tab = { id: randomUUID(), owner, profile, stills: this.stillPreferences.get(owner) !== false, partition: input.partition ?? (profile === "signed_in" ? "persist:butler-web" : this.conversationPartitions.get(owner)),
      agent: input.agent === true, policy: input.policy ?? {}, epoch: 1, holder: owner === "mine" ? "user" : "agent", sticky: false, waiting: false, busy: false, observation: null, url, title: "", favicon: "", status: "idle", canBack: false, canForward: false,
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
    if (this.activeId && this.activeId !== id) {
      const previous = this.tabs.get(this.activeId);
      if (previous?.holder === "user" && !previous.sticky) controlTab(this, previous, "agent");
      this.detach(previous); backgroundTab(this, previous ?? {});
    }
    tab.viewed = true; clearTimeout(tab.expiry);
    this.activeId = id;
    this.materialize(tab);
    this.sync(tab);
    this.publish();
  }
  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.detach(tab);
    const profile = tab.session;
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    clearTimeout(tab.expiry);
    this.tabs.delete(id);
    if (tab.profile === "signed_out" && ![...this.tabs.values()].some(item => item.partition === tab.partition)) {
      if (profile) { void profile.clearStorageData(); void profile.clearCache(); }
      for (const [owner, partition] of this.conversationPartitions) if (partition === tab.partition) this.conversationPartitions.delete(owner);
      this.profiles.delete(tab.partition);
    }
    if (![...this.tabs.values()].some(item => item.agent || item.driven)) { this.agentWindow?.destroy(); this.agentWindow = null; }
    if (tab.owner === "mine") this.restore.changed();
    if (this.activeId === id) {
      this.activeId = null;
      const next = [...this.tabs.keys()].at(-1);
      if (next) this.activate(next);
    }
    this.publish();
  }
  shortcut(input, nativePage = false) {
    if (!this.areaVisible || (!nativePage && !this.keyboardFocused) || input.type !== "keyDown") return false;
    const command = input.meta || input.control;
    const key = input.key.toLowerCase();
    if (command && key === "l") {
      this.getWindow()?.webContents.focus(); this.getWindow()?.webContents.send("butler-browser:address");
    } else if (command && key === "t") {
      if (this.enabled()) this.create({ owner: this.areaOwner });
    }
    else if (command && key === "w") { if (this.activeId) this.close(this.activeId); }
    else if ((input.alt && ["arrowleft", "arrowright"].includes(key)) || (command && ["[", "]"].includes(key))) {
      if (this.enabled() && this.activeId) this.commandTab(key === "arrowleft" || key === "[" ? "back" : "forward", this.activeId);
    } else return false;
    return true;
  }
  commandTab(op, id, value) {
    const tab = this.tabs.get(id);
    if (!tab) {
      // Slot teardown reports hidden or uncovered after the tab has been closed.
      if (op === "bounds" || op === "covered") return;
      throw new Error("unknown_tab");
    }
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
    if (!tab || (toGroupId !== "mine" && !/^conversation:[a-zA-Z0-9_-]{1,128}$/u.test(toGroupId)) || !Number.isInteger(index)) throw new Error("invalid_move");
    if(toGroupId!==tab.owner) {
      const peers=[...this.tabs.values()].filter(item=>item.owner===toGroupId);
      if(toGroupId==="mine" ? peers.length>=30 : (tab.agent || tab.driven) && peers.filter(item=>item.agent || item.driven).length>=3) throw new Error("tab_budget_exhausted");
    }
    const previousOwner = tab.owner;
    if (toGroupId !== tab.owner) { tab.owner = toGroupId; tab.epoch++; tab.observation = null; tab.holder = toGroupId === "mine" ? "user" : "agent"; tab.sticky = false; }
    const ordered = [...this.tabs.values()].filter((item) => item.id !== tabId);
    const peers = ordered.filter((item) => item.owner === tab.owner);
    const before = peers[Math.max(0, index)];
    ordered.splice(before ? ordered.indexOf(before) : ordered.length, 0, tab);
    this.tabs.clear(); for (const item of ordered) this.tabs.set(item.id, item);
    if (tab.owner === "mine" || previousOwner === "mine") this.restore.changed(); this.publish();
  }
  focusArea(value, owner) {
    this.keyboardFocused = value;
    if (owner === "mine" || /^conversation:[a-zA-Z0-9_-]{1,128}$/u.test(owner ?? "")) this.areaOwner = owner;
  }
  hide() {
    this.keyboardFocused = false; this.areaVisible = false;
    for (const tab of this.tabs.values()) {
      if (tab.holder === "user" && !tab.sticky) controlTab(this, tab, "agent");
      this.detach(tab); backgroundTab(this, tab);
    }
  }
  control(id, holder, sticky) {
    if (!["agent", "user"].includes(holder)) throw new Error("invalid_control");
    controlTab(this, this.tabs.get(id), holder, sticky);
  }
  setStills(id, value) {
    const tab = this.tabs.get(id); if (!tab || tab.owner === "mine") return;
    this.stillPreferences.set(tab.owner, value !== false);
    for (const peer of this.tabs.values()) if (peer.owner === tab.owner) peer.stills = value !== false;
    this.publish();
  }
  execute(frame) { return executeBrowser(this, frame); }
  syncAll() { for (const tab of this.tabs.values()) this.sync(tab); }
  flush() { return this.restore.flush(); }
  async dispose() {
    this.areaVisible = false;
    clearTimeout(this.metadataTimer);
    for (const tab of this.tabs.values()) clearTimeout(tab.expiry);
    await Promise.all([...this.tabs.values()].map((tab) => {
      if (tab.attached && !tab.attached.isDestroyed() && tab.view) tab.attached.contentView.removeChildView(tab.view);
      tab.attached = null;
      const contents = tab.view?.webContents;
      tab.view = null;
      if (!contents || contents.isDestroyed()) return;
      return new Promise((resolve) => {
        contents.once("destroyed", resolve);
        contents.close({ waitForBeforeUnload: false });
      });
    }));
    this.agentWindow?.destroy(); this.agentWindow = null;
  }
}

export function createUserBrowser(app, getWindow) { return new UserBrowser(app, getWindow); }
