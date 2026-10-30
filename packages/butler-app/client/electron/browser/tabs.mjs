import { disposeMarkingHost, startMarkingHost } from "./marking-host.mjs";
import { BrowserLiveFrames } from "./live.mjs";
import { linkMenuItems } from "./links.mjs";
import { configureWebSession } from "./identity.mjs";
import { wireHistory } from "./history.mjs";
import { isHistoryShortcut } from "../butler-platform/browser-shortcuts.mjs";
import { BrowserDownloads } from "./downloads.mjs";
import { BrowserSelection } from "./selection.mjs";
import { BrowserPointer } from "./pointer.mjs";
import { tabInUse, resetUse, closeUse } from "./usage.mjs";
import { WebContentsView } from "electron";
import { randomUUID } from "node:crypto";
import { shortId } from "./ids.mjs";
import { MAX_TABS, USER_TABS, agentTabFits } from "./capacity.mjs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachNativeWorlds } from "./native-worlds.mjs";
import { watchArrival } from "./devtools.mjs";
import { addressUrl, browsingEnabled, createLossBreaker, webUrl } from "./policy.mjs";
import { createTabRestore } from "./restore.mjs";
import { backgroundTab, controlTab, emulation, hearTab, wireAgentTab, executeBrowser, viewedTab } from "./agent.mjs";
import { wireUserDialogs, publicDialog, prepareUserNavigation } from "./user-dialogs.mjs";
import { popupHandler, allowPopup, syncPopup, closePopups, publishPopup } from "./popups.mjs";
import { resolveDialog, requestClose } from "./dialogs.mjs";
import { protectPartition, wireTab } from "./tab-events.mjs";
import { clearOffer } from "./signin-offer.mjs";
import { drainStills } from "./still-delivery.mjs";
import { attachView, capturePage, detachView } from "./view-capture.mjs";

/** One registry per App; no web view before Browser activation. */
class UserBrowser {
  tabs = new Map();
  uses = new Map();
  holds = new Map();
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

  constructor(app, getWindow, getLanguage) {
    startMarkingHost();
    this.getWindow = getWindow;
    this.live = new BrowserLiveFrames(this);
    this.getLanguage = getLanguage;
    this.pointer = new BrowserPointer(this, controlTab);
    this.selection = new BrowserSelection(this);
    this.downloads = new BrowserDownloads(this, join(app.getPath("userData"), "browser-downloads"));
    this.breaker = createLossBreaker(() => this.trip());
    this.restore = createTabRestore(join(app.getPath("userData"), "browser"), () =>
      [...this.tabs.values()].filter((tab) => tab.owner === "mine" && !tab.popup).map((tab) => tab.url));
    app.on("child-process-gone", (_event, detail) => {
      if (detail.type === "GPU" && detail.reason !== "clean-exit") this.breaker.loss(this.tabs.size > 0);
    });
  }
  enabled() { return browsingEnabled() && !this.breaker.tripped; }
  snapshot() {
    const popups = new Map();
    for (const child of this.tabs.values()) if (child.popup && child.opener && !child.closing) popups.set(child.opener, { id: child.id, url: child.url });
    return { restored: this.opened, enabled: this.enabled(), blocked: this.breaker.tripped, activeId: this.activeId, nativeCovered: this.nativeCovers > 0, focusRequest: this.focusRequest,
      tabs: [...this.tabs.values()].filter(tab => !tab.popup).map(tab => ({ id: tab.id, owner: tab.owner, opener: tab.opener, preview: tab.preview, popup: popups.get(tab.id), dialog: publicDialog(tab), blockedPopup: tab.blockedPopup, url: tab.url, title: tab.title, favicon: tab.favicon, status: tab.status, canBack: tab.canBack, canForward: tab.canForward, agent: tab.agent, driven: tab.driven, profile: tab.profile, epoch: tab.epoch, holder: tab.holder, sticky: tab.sticky, waiting: tab.waiting, busy: tab.busy, inUse: tabInUse(this, tab) || Boolean(tab.stillJobs?.size), paused: Boolean(tab.pausedTurns), agentAt: tab.lastAgentCall ?? undefined, privacyFrozen: this.live.sensitive(tab), picking: tab.picking === true, selectionCount: tab.selections?.length ?? 0, stills: this.stillPreferences.get(tab.owner) !== false,
        signinStep: tab.signinStep ?? undefined, payStep: tab.payStep ?? undefined, saveOffer: tab.saveOffer ? { username: tab.saveOffer.username, host: new URL(tab.saveOffer.origin).host } : undefined })) };
  }
  publish() {
    this.live.sync();
    this.pointer.sync(this.tabs.get(this.activeId));
    this.onState?.(this.snapshot());
    const win = this.getWindow();
    if (win && this.boundWindow !== win) {
      this.boundWindow = win;
      win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.hide(); });
    }
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("butler-browser:state", this.snapshot());
  }
  resetUse() { resetUse(this); }
  trip() {
    this.resetUse();
    for (const tab of [...this.tabs.values()]) {
      void resolveDialog(this, tab, { accept: false }, "crashed"); closePopups(this, tab);
      this.detach(tab);
      tab.view?.webContents.close({ waitForBeforeUnload: false });
      tab.view = null;
      tab.status = "crashed";
    }
    this.publish();
  }
  detach(tab) {
    // Layout/preview occlusion must not remove a held overlay: macOS synthesizes
    // mouseUp at (0,0), losing the click/drag release and its destination.
    // Navigation may hide the area while a held pick is being carried into the App.
    const dragging = this.pointer.captures(tab?.id) && tab.id === this.activeId && !this.nativeCovers;
    if (tab?.id === this.activeId && !dragging) this.pointer.hide();
    if (tab?.attached && tab.view) {
      void this.capture(tab);
      detachView(tab, () => {
        if (this.tabs.get(tab.id) === tab && !tab.closing && !tab.closeRequested && tab.view && !tab.view.webContents.isDestroyed()) this.sync(tab);
      });
    }
  }
  sync(tab) {
    if (tab?.popupWindow) { syncPopup(this, tab); return; }
    const win = this.getWindow();
    const visible = win && !win.isDestroyed() && win.isVisible() && this.areaVisible && tab.id === this.activeId &&
      tab.slot?.visible && !tab.covered && !tab.dialog && this.nativeCovers === 0 && tab.status !== "crashed";
    if (!visible || !tab.view) { this.detach(tab); backgroundTab(this, tab); return; }
    viewedTab(this, tab, true);
    // Occlusion can clear while a held drag goes on (its floating preview lifts in over the page).
    // Adding the page above the overlay would cancel the overlay's native capture, so the page
    // returns beneath it and stays on screen for the rest of the drag.
    const held = this.pointer.captures(tab.id) && this.pointer.attached === win;
    if (tab.attached !== win) this.detach(tab);
    tab.bounds = tab.slot;
    attachView(tab, win, held ? win.contentView.children.indexOf(this.pointer.view) : -1, () => {
      const { x, y, width, height } = tab.bounds;
      const left = Math.round(x), top = Math.round(y);
      tab.view.setBounds({ x: left, y: top, width: Math.round(x + width) - left, height: Math.round(y + height) - top });
      tab.view.setBorderRadius(Math.max(0, Math.round(tab.bounds.radius ?? 0)));
      emulation(tab); this.pointer.sync(tab);
    }, () => { if (this.tabs.get(tab.id) === tab) this.sync(tab); });
  }
  async capture(tab) {
    if (tab.dialog) return tab.still;
    if (!tab.view?.webContents || tab.view.webContents.isDestroyed() || tab.status === "crashed") return tab.still;
    if (tab.capture) return tab.capture;
    tab.capture = capturePage(tab).then((image) => {
      if (!image.isEmpty()) tab.still = `data:image/jpeg;base64,${image.toJPEG(75).toString("base64")}`;
      return tab.still;
    }).catch(() => tab.still).finally(() => { tab.capture = null; });
    return tab.capture;
  }
  update(tab) {
    if (!tab.view?.webContents || tab.view.webContents.isDestroyed() || tab.status === "crashed") return;
    const contents = tab.view.webContents;
    const url = webUrl(contents.getURL());
    if (url && url !== tab.url) { tab.url = url; if (tab.owner === "mine") this.restore.changed(); }
    tab.title = contents.getTitle();
    publishPopup(tab);
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
  pagePreferences(tab) {
    return { preload: fileURLToPath(new URL("./page-controls.cjs", import.meta.url)),
      nodeIntegrationInSubFrames: true, additionalArguments: [...(tab.agent ? ["--butler-agent-page"] : []), ...(tab.profile === "signed_in" ? ["--butler-signin-capture"] : [])],
      disableDialogs: !tab.agent, partition: tab.partition, webgl: true,
      contextIsolation: true, nodeIntegration: false, sandbox: true, navigateOnDragDrop: false };
  }
  materialize(tab) {
    if (tab.wired || !this.enabled()) return;
    const partition = tab.partition;
    if (!this.profiles.has(partition)) {
      protectPartition(partition, this); this.profiles.add(partition);
    }
    const supplied = Boolean(tab.view);
    tab.view ??= new WebContentsView({ webPreferences: this.pagePreferences(tab) });
    // A page Butler opens stays silent until the user takes the tab over.
    if (tab.muted) tab.view.webContents.setAudioMuted(true);
    tab.wired = true;
    tab.session = tab.view.webContents.session;
    tab.identityReady = configureWebSession(tab.session);
    attachNativeWorlds(tab);
    watchArrival(tab);
    this.live.watch(tab);
    tab.afterCapture = image => this.live.changed(tab, image);
    wireTab(tab, { update: (item) => this.update(item), capture: (item) => this.capture(item),
      detach: (item) => this.detach(item), publish: () => this.publish(), nativeCover: () => this.nativeCover(),
      linkMenu: (url) => linkMenuItems(this, url, tab), language: this.getLanguage,
      window: this.getWindow, shortcut: (input) => {
        if (tab.popupWindow && input.type === "keyDown" && (input.meta || input.control) && input.key.toLowerCase() === "w") { tab.popupWindow.close(); return true; }
        return this.shortcut(input, true);
      },
      popup: (source, details) => popupHandler(this, source, details) });
    wireHistory(this, tab);
    wireUserDialogs(this, tab);
    this.selection.watch(tab);
    if (tab.agent) wireAgentTab(this, tab);
    if (tab.url && !tab.agent && !supplied) void tab.identityReady.then(() => tab.view.webContents.loadURL(tab.url)).catch(() => {});
  }
  allowPopup(id) { return allowPopup(this, id); }
  create(input = {}, activateTab = true, popupSource) {
    if (!this.enabled()) throw new Error("browsing_disabled");
    const owner = input.owner ?? "mine";
    if (owner !== "mine" && !/^conversation:[a-zA-Z0-9_-]{1,128}$/u.test(owner)) throw new Error("invalid_owner");
    // A placeholder only fills an empty group. A pane asks for one from the state it was last sent, so a
    // request that arrives after a tab has opened in or moved back into the group is stale.
    if (input.placeholder === true && !input.url && !popupSource && [...this.tabs.values()].some(tab => tab.owner === owner)) return null;
    if(this.tabs.size>=MAX_TABS) throw new Error("tab_budget_exhausted");
    const url = input.url ? webUrl(input.url) : "";
    if (input.url && !url) throw new Error("blocked_protocol");
    if (owner === "mine" && [...this.tabs.values()].filter(tab => tab.owner === "mine").length >= USER_TABS) throw new Error("tab_budget_exhausted");
    const output = url && new URL(url).hostname === "127.0.0.1" && ["/__o/", "/__p/"].some(prefix => new URL(url).pathname.startsWith(prefix));
    const profile = input.profile ?? (input.agent || output ? "signed_out" : "signed_in");
    if(input.agent===true && !agentTabFits(this)) throw new Error("tab_budget_exhausted");
    const partitionOwner = input.preview_id ? `${owner}:preview:${input.preview_id}` : owner;
    if (profile === "signed_out" && !this.conversationPartitions.has(partitionOwner)) this.conversationPartitions.set(partitionOwner, `butler-conv-${randomUUID()}`);
    const tab = { id: shortId("t", id => this.tabs.has(id)), owner, profile, popup: Boolean(popupSource), opener: popupSource?.id, popupParentUrl: popupSource?.url, stills: this.stillPreferences.get(owner) !== false, partition: input.partition ?? (profile === "signed_in" ? "persist:butler-web" : this.conversationPartitions.get(partitionOwner)),
      preview: input.preview_id ?? (url && new URL(url).pathname.startsWith("/__p/") ? new URL(url).pathname.slice(5) : undefined),
      agent: input.agent === true, muted: input.agent === true, placeholder: input.placeholder === true && !url && !popupSource, policy: input.policy ?? {}, epoch: 1, holder: owner === "mine" ? "user" : "agent", sticky: false, waiting: false, busy: false, observation: null, url, title: "", favicon: "", status: "idle", canBack: false, canForward: false,
      still: "", view: null, attached: null, slot: null, bounds: null, covered: false, capture: null };
    tab.onStillChanged = () => this.publish();
    this.tabs.set(tab.id, tab);
    if (owner === "mine") this.restore.changed();
    if (activateTab) this.activate(tab.id);
    if (url) this.dropPlaceholders(owner);
    this.publish();
    return tab.id;
  }
  /** A page that opens in or moves into a group takes the place of the empty tab its pane opened on its own; the pane then shows that page. */
  dropPlaceholders(owner) {
    for (const tab of [...this.tabs.values()]) {
      if (!tab.placeholder || tab.owner !== owner || tab.url) continue;
      if (this.activeId === tab.id) this.activeId = null;
      this.close(tab.id);
    }
  }
  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.activeId && this.activeId !== id) {
      const previous = this.tabs.get(this.activeId);
      if (previous?.holder === "user" && !previous.sticky) controlTab(this, previous, "agent");
      this.detach(previous); backgroundTab(this, previous ?? {});
    }
    if (tab.waiting && !tab.dialog) controlTab(this, tab, "user");
    tab.viewed = true; clearTimeout(tab.expiry);
    this.activeId = id;
    this.materialize(tab);
    this.sync(tab);
    this.publish();
  }
  close(id) {
    const tab = this.tabs.get(id);
    if (!tab || tab.closing) return;
    if (!tab.stillsDrained && (tab.activeAct || tab.stillJobs?.size)) {
      tab.closeDrain ??= drainStills(tab).finally(() => { tab.stillsDrained = true; this.close(id); });
      return tab.closeDrain;
    }
    tab.flushHistory?.();
    tab.closing = true;
    this.live.unsubscribe(id);
    clearOffer(tab);
    this.downloads.cancelTab(id);
    closeUse(this, tab);
    void resolveDialog(this, tab, { accept: false }, "tab_closed");
    this.detach(tab);
    closePopups(this, tab);
    const profile = tab.session;
    if (tab.view?.webContents && !tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
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
    if (isHistoryShortcut(input)) { this.getWindow()?.webContents.focus(); this.getWindow()?.webContents.send("butler-browser:history"); return true; }
    if (!this.areaVisible || input.type !== "keyDown") return false;
    if (this.selection.shortcut(input)) return true;
    if (!nativePage && !this.keyboardFocused) return false;
    const picking = this.tabs.get(this.activeId);
    if (input.key === "Escape" && picking?.picking) { this.selection.mode(this.activeId, false); return true; }
    if (picking?.picking && ["ArrowUp", "ArrowDown"].includes(input.key) && !input.meta && !input.control && !input.alt) {
      this.selection.step(picking, input.key === "ArrowUp" ? 1 : -1); return true;
    }
    const command = input.meta || input.control;
    const key = input.key.toLowerCase();
    if (command && key === "l") {
      this.getWindow()?.webContents.focus(); this.getWindow()?.webContents.send("butler-browser:address");
    } else if (command && key === "t") {
      if (this.enabled()) this.create({ owner: this.areaOwner });
    }
    else if (command && key === "w") { if (this.activeId) void requestClose(this, this.tabs.get(this.activeId)); }
    else if ((input.alt && ["arrowleft", "arrowright"].includes(key)) || (command && ["[", "]"].includes(key))) {
      if (this.enabled() && this.activeId) this.commandTab(key === "arrowleft" || key === "[" ? "back" : "forward", this.activeId);
    } else return false;
    return true;
  }
  commandTab(op, id, value, approved = false) {
    const tab = this.tabs.get(id);
    if (!tab) {
      // Slot teardown reports hidden or uncovered after the tab has been closed.
      if (op === "bounds" || op === "covered") return;
      throw new Error("unknown_tab");
    }
    if (op === "bounds") {
      if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite) || value.width < 0 || value.height < 0) throw new Error("invalid_bounds");
      // The slot alone decides where the page shows; a hidden agent page is placed in its own viewport.
      tab.slot = value; if (!tab.agent) tab.bounds = value;
      this.sync(tab); return;
    }
    if (op === "covered") { tab.covered = value === true; this.sync(tab); return; }
    if (op === "still") return this.capture(tab);
    if (!this.enabled()) throw new Error("browsing_disabled");
    if (tab.holder === "agent" && (tab.busy || tabInUse(this, tab))) throw new Error("agent_control");
    this.materialize(tab);
    if (op === "navigate") { value = addressUrl(value); if (!value) return; tab.placeholder = false; }
    if (!approved && !tab.agent && !tab.driven && ["navigate", "reload", "back", "forward"].includes(op)) { prepareUserNavigation(this, tab, op, value); return; }
    const contents = tab.view.webContents;
    if (["navigate", "reload", "back", "forward"].includes(op)) tab.navigationIntent = { op, value };
    if (op === "navigate") {
      const url = addressUrl(value);
      if (url) {
        tab.status = "loading"; tab.url = url;
        if (tab.owner === "mine") this.restore.changed();
        void tab.identityReady.then(() => contents.loadURL(url)).catch(() => {});
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
    if (tab.opener && this.tabs.get(tab.opener)?.owner !== toGroupId) throw new Error("invalid_popup_owner");
    if(toGroupId!==tab.owner) {
      const peers=[...this.tabs.values()].filter(item=>item.owner===toGroupId);
      if(toGroupId==="mine" && peers.length>=USER_TABS) throw new Error("tab_budget_exhausted");
    }
    const previousOwner = tab.owner;
    if (toGroupId !== tab.owner) this.downloads.cancelTab(tabId);
    if (toGroupId !== tab.owner) { void resolveDialog(this, tab, { accept: false }, "owner_changed"); closePopups(this, tab); }
    if (toGroupId !== tab.owner) { closeUse(this, tab); tab.owner = toGroupId; tab.epoch++; tab.observation = null; tab.holder = toGroupId === "mine" ? "user" : "agent"; if (toGroupId === "mine") hearTab(tab); tab.sticky = false; tab.waiting = false; tab.waitingTurn = null; tab.pausedTurns = null; tab.pointer = null; }
    const ordered = [...this.tabs.values()].filter((item) => item.id !== tabId);
    const peers = ordered.filter((item) => item.owner === tab.owner);
    const before = peers[Math.max(0, index)];
    ordered.splice(before ? ordered.indexOf(before) : ordered.length, 0, tab);
    this.tabs.clear(); for (const item of ordered) this.tabs.set(item.id, item);
    if (tab.owner !== previousOwner && tab.url) this.dropPlaceholders(tab.owner);
    if (tab.owner === "mine" || previousOwner === "mine") this.restore.changed(); this.publish();
    return tabId;
  }
  focusArea(value, owner) {
    this.keyboardFocused = value;
    if (owner === "mine" || /^conversation:[a-zA-Z0-9_-]{1,128}$/u.test(owner ?? "")) this.areaOwner = owner;
  }
  hide() {
    this.keyboardFocused = false; this.areaVisible = false;
    for (const tab of this.tabs.values()) {
      if (tab.dialog) tab.waiting = true;
      if (tab.popupWindow) continue;
      if (tab.holder === "user" && !tab.sticky) controlTab(this, tab, "agent");
      this.detach(tab); backgroundTab(this, tab);
    }
    this.live.sync();
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
  async execute(frame) {
    const filled = ["signin.fill", "pay.fill", "autofill.fill"].includes(frame.op);
    const action = ["tab.act", "tab.dialog"].includes(frame.op);
    const release = filled || action ? this.live.pauseCapture(frame.tab, filled) : () => {};
    try { return await executeBrowser(this, frame); }
    finally {
      release();
      if (frame.op === "tab.zoom") this.live.changed(this.tabs.get(frame.tab));
    }
  }
  syncAll() { for (const tab of this.tabs.values()) this.sync(tab); }
  flush() { return this.restore.flush(); }
  drainStills(until = performance.now() + 1500) {
    return Promise.all([...this.tabs.values()].map(tab => drainStills(tab, until)));
  }
  async dispose() {
    this.disposing = true;
    await this.drainStills();
    await disposeMarkingHost();
    this.live.dispose();
    this.downloads.stop();
    this.resetUse();
    this.areaVisible = false;
    clearTimeout(this.metadataTimer);
    for (const tab of this.tabs.values()) { clearTimeout(tab.expiry); void resolveDialog(this, tab, { accept: false }, "shutdown"); closePopups(this, tab); }
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
    this.pointer.dispose();
    this.agentWindow?.destroy(); this.agentWindow = null;
  }
}

export function createUserBrowser(app, getWindow, getLanguage = async () => "en") { return new UserBrowser(app, getWindow, getLanguage); }
