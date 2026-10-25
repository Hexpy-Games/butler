import { powerMonitor } from "electron";
import { secureBoxes, captureViewport } from "./capture-security.mjs";
import { maskSecure } from "./capture.mjs";
import { capturePage } from "./view-capture.mjs";

const REFRESH_MS = 2000;

/** Ephemeral desktop-only frames. Neither tab metadata nor history owns bytes. */
export class BrowserLiveFrames {
  subscriptions = new Map();
  pauses = new Map();
  documentVisible = true;
  screenLocked = false;
  window = null;
  windowListeners = [];

  constructor(browser) {
    this.browser = browser;
    this.lockScreen = () => { this.screenLocked = true; this.sync(); };
    this.unlockScreen = () => { this.screenLocked = false; this.resume(); };
    powerMonitor.on("lock-screen", this.lockScreen);
    powerMonitor.on("unlock-screen", this.unlockScreen);
  }

  resume() {
    for (const state of this.subscriptions.values()) if (!state.frozen) state.dirty = true;
    this.sync();
  }

  subscribe(id, sender, widthPx = 416) {
    const tab = this.browser.tabs.get(id);
    if (!tab || tab.closing) throw new Error("invalid_frame_tab");
    const width = Number.isFinite(widthPx) ? Math.max(48, Math.min(416, Math.round(widthPx))) : 416;
    const existing = this.subscriptions.get(id);
    if (existing) {
      if (existing.width !== width) {
        existing.width = width; existing.revision++; existing.dirty = true; existing.frozen = false;
        // A newly wider slot needs its own frame now, rather than the shelf refresh delay.
        existing.attemptedAt = 0;
        this.sync();
      }
      return;
    }
    const state = { sender, width, seq: 0, revision: 0, dirty: true, sensitive: this.sensitive(tab), frozen: false, timer: null, capturing: false, attemptedAt: 0 };
    this.subscriptions.set(id, state);
    this.sync();
  }

  unsubscribe(id) {
    const state = this.subscriptions.get(id);
    if (state) clearTimeout(state.timer);
    this.subscriptions.delete(id);
  }

  visibility(value) { this.documentVisible = value; if (value) this.resume(); else this.sync(); }

  watch(tab) {
    const contents = tab.view.webContents;
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.changed(tab); });
    for (const event of ["did-navigate", "did-navigate-in-page", "did-start-loading", "did-stop-loading", "did-finish-load"])
      contents.on(event, () => this.changed(tab));
    contents.once("destroyed", () => this.unsubscribe(tab.id));
  }

  bindWindow() {
    const win = this.browser.getWindow();
    if (win === this.window) return;
    this.unbindWindow(); this.window = win;
    if (!win || win.isDestroyed()) return;
    for (const event of ["show", "hide", "minimize", "restore"]) {
      const listener = () => { if (event === "show" || event === "restore") this.resume(); else this.sync(); };
      win.on(event, listener); this.windowListeners.push([event, listener]);
    }
    const reset = () => { for (const id of this.subscriptions.keys()) this.unsubscribe(id); };
    this.navigationReset = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) reset(); };
    win.webContents.on("did-start-navigation", this.navigationReset);
    win.webContents.once("destroyed", reset);
    win.webContents.on("render-process-gone", reset);
    this.resetRenderer = reset;
  }

  unbindWindow() {
    if (this.window && !this.window.isDestroyed()) {
      for (const [event, listener] of this.windowListeners) this.window.removeListener(event, listener);
      this.window.webContents.removeListener("did-start-navigation", this.navigationReset);
      this.window.webContents.removeListener("destroyed", this.resetRenderer);
      this.window.webContents.removeListener("render-process-gone", this.resetRenderer);
    }
    this.windowListeners = [];
  }

  allowed(tab, state) {
    const win = this.window;
    return !this.screenLocked && (tab?.agent || tab?.driven) && this.documentVisible && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() &&
      !state.sender.isDestroyed() && tab?.view && !tab.view.webContents.isDestroyed() &&
      !this.pauses.has(tab.id) && !tab.closing && tab.status !== "crashed" && !tab.dialog &&
      !(this.browser.areaVisible && this.browser.activeId === tab.id);
  }

  /** Saved-item fills and human secure steps freeze the card on one masked still. */
  sensitive(tab) {
    return Boolean(tab.vaultFilled || tab.payStep || tab.signinStep === "secure_keypad");
  }

  pauseCapture(id, filled = false) {
    if (!id) return () => {};
    this.pauses.set(id, (this.pauses.get(id) ?? 0) + 1);
    this.changed(this.browser.tabs.get(id));
    return () => {
      const remaining = (this.pauses.get(id) ?? 1) - 1;
      if (remaining) this.pauses.set(id, remaining); else this.pauses.delete(id);
      if (filled) this.changed(this.browser.tabs.get(id)); else this.sync();
    };
  }

  changed(tab, image = null) {
    const state = this.subscriptions.get(tab?.id);
    if (!state) return;
    state.revision++; state.dirty = true; state.pendingImage = image;
    this.sync();
  }

  sync() {
    if (!this.subscriptions.size) return;
    this.bindWindow();
    for (const [id, state] of this.subscriptions) {
      const tab = this.browser.tabs.get(id);
      if (!tab || state.sender.isDestroyed()) { this.unsubscribe(id); continue; }
      const sensitive = this.sensitive(tab);
      if (state.sensitive !== sensitive) {
        state.sensitive = sensitive; state.frozen = false; state.dirty = true; state.revision++; state.pendingImage = null;
      }
      if (!this.allowed(tab, state) || state.frozen) {
        clearTimeout(state.timer); state.timer = null;
        if (state.frozen || this.screenLocked || !this.documentVisible || !this.window?.isVisible() || this.window?.isMinimized()) state.pendingImage = null;
        continue;
      }
      if (!state.timer && !state.capturing && (state.dirty || tab.view.webContents.isLoading())) {
        state.timer = setTimeout(() => { state.timer = null; void this.capture(tab, state); }, Math.max(0, state.attemptedAt + REFRESH_MS - Date.now()));
      }
    }
  }

  async capture(tab, state) {
    if (this.subscriptions.get(tab.id) !== state || !this.allowed(tab, state) || state.frozen) return;
    state.capturing = true; state.dirty = false; state.attemptedAt = Date.now();
    const revision = state.revision;
    try {
      const masked = this.sensitive(tab);
      let image = state.pendingImage; state.pendingImage = null;
      image ??= await capturePage(tab, undefined, { stayHidden: true, stayAwake: true });
      if (image.isEmpty()) return;
      // Locating secure fields re-runs page perception, so only sensitive pages pay for it.
      const marks = masked ? await secureBoxes(tab) : [];
      // Fail closed: an unlocatable sensitive surface cannot become a thumbnail.
      if (masked && !marks.length) {
        const viewport = await captureViewport(tab);
        const scale = tab.bounds?.scale ?? 1;
        marks.push({ secure: true, rect: { x: 0, y: 0, width: viewport.width * scale, height: viewport.height * scale } });
      }
      image = image.resize({ width: state.width, height: Math.round(state.width * 260 / 416) });
      if (masked) image = await maskSecure(tab, image, marks);
      if (this.subscriptions.get(tab.id) !== state || revision !== state.revision) return;
      if (!this.allowed(tab, state) || this.sensitive(tab) !== masked) {
        state.dirty = true; return;
      }
      state.dirty = false; state.frozen = masked;
      state.sender.send("browser:frame", { tab: tab.id, seq: ++state.seq, bytes: new Uint8Array(image.toJPEG(60)), masked });
    } catch { /* A destroyed or unreadable page never emits unmasked pixels. */ }
    finally { state.capturing = false; this.sync(); }
  }

  dispose() {
    for (const id of this.subscriptions.keys()) this.unsubscribe(id);
    this.pauses.clear(); this.unbindWindow(); this.window = null;
    powerMonitor.removeListener("lock-screen", this.lockScreen);
    powerMonitor.removeListener("unlock-screen", this.unlockScreen);
  }
}
