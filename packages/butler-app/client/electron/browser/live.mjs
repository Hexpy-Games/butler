import { powerMonitor } from "electron";
import { secureBoxes, captureViewport } from "./capture-security.mjs";
import { maskSecure } from "./capture.mjs";

const REFRESH_MS = 2000;
const IDLE_SECONDS = 60;

/** Ephemeral desktop-only frames. Neither tab metadata nor history owns bytes. */
export class BrowserLiveFrames {
  subscriptions = new Map();
  fills = new Map();
  documentVisible = true;
  window = null;
  windowListeners = [];

  constructor(browser) { this.browser = browser; }

  subscribe(id, sender, widthPx = 416) {
    const tab = this.browser.tabs.get(id);
    if (!tab || !(tab.agent || tab.driven) || tab.closing) throw new Error("invalid_frame_tab");
    if (this.subscriptions.has(id)) return;
    const width = Number.isFinite(widthPx) ? Math.max(48, Math.min(416, Math.round(widthPx))) : 416;
    const state = { sender, width, seq: 0, revision: 0, dirty: true, frozen: false, frame: null, timer: null, capturing: false, attemptedAt: 0 };
    this.subscriptions.set(id, state);
    this.sync();
  }

  unsubscribe(id) {
    const state = this.subscriptions.get(id);
    if (state) clearTimeout(state.timer);
    this.subscriptions.delete(id);
  }

  visibility(value) { this.documentVisible = value; this.sync(); }

  watch(tab) {
    const contents = tab.view.webContents;
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return;
      const state = this.subscriptions.get(tab.id);
      if (state) { state.frozen = false; state.frame = null; }
      this.changed(tab);
    });
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
      const listener = () => this.sync();
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
    return this.documentVisible && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() &&
      !state.sender.isDestroyed() && tab?.view && !tab.view.webContents.isDestroyed() &&
      !this.fills.has(tab.id) && !tab.closing && tab.status !== "crashed" && !tab.dialog &&
      !(this.browser.areaVisible && this.browser.activeId === tab.id);
  }

  pauseFill(id) {
    if (!id) return () => {};
    this.fills.set(id, (this.fills.get(id) ?? 0) + 1);
    this.changed(this.browser.tabs.get(id));
    return () => {
      const remaining = (this.fills.get(id) ?? 1) - 1;
      if (remaining) this.fills.set(id, remaining); else this.fills.delete(id);
      this.changed(this.browser.tabs.get(id));
    };
  }

  changed(tab) {
    const state = this.subscriptions.get(tab?.id);
    if (!state) return;
    state.revision++; state.dirty = true;
    this.sync();
  }

  sync() {
    if (!this.subscriptions.size) return;
    this.bindWindow();
    for (const [id, state] of this.subscriptions) {
      const tab = this.browser.tabs.get(id);
      if (!tab || state.sender.isDestroyed()) { this.unsubscribe(id); continue; }
      if (!this.allowed(tab, state) || state.frozen) { clearTimeout(state.timer); state.timer = null; continue; }
      if (!state.timer && !state.capturing && (state.dirty || tab.view.webContents.isLoading())) {
        state.timer = setTimeout(() => { state.timer = null; void this.capture(tab, state); }, Math.max(0, state.attemptedAt + REFRESH_MS - Date.now()));
      }
    }
  }

  async capture(tab, state) {
    if (this.subscriptions.get(tab.id) !== state || !this.allowed(tab, state) || state.frozen) return;
    if (powerMonitor.getSystemIdleTime() >= IDLE_SECONDS) {
      state.timer = setTimeout(() => { state.timer = null; this.sync(); }, REFRESH_MS);
      return;
    }
    state.capturing = true; state.dirty = false; state.attemptedAt = Date.now();
    const revision = state.revision;
    try {
      let image = await tab.view.webContents.capturePage(undefined, { stayHidden: true });
      if (image.isEmpty()) return;
      const marks = await secureBoxes(tab);
      const masked = Boolean(marks.length || tab.vaultFilled || tab.payStep || tab.signinStep === "secure_keypad");
      // Fail closed: an unlocatable sensitive surface cannot become a thumbnail.
      if (masked && !marks.length) {
        const viewport = await captureViewport(tab);
        const scale = tab.bounds?.scale ?? 1;
        marks.push({ secure: true, rect: { x: 0, y: 0, width: viewport.width * scale, height: viewport.height * scale } });
      }
      image = image.resize({ width: state.width, height: Math.round(state.width * 260 / 416) });
      if (masked) image = await maskSecure(tab, image, marks);
      if (this.subscriptions.get(tab.id) !== state || revision !== state.revision) return;
      if (!this.allowed(tab, state) || powerMonitor.getSystemIdleTime() >= IDLE_SECONDS) {
        state.dirty = true; return;
      }
      state.frame = { tab: tab.id, seq: ++state.seq, bytes: new Uint8Array(image.toJPEG(60)), masked };
      state.dirty = false; state.frozen = masked;
      state.sender.send("browser:frame", state.frame);
    } catch { /* A destroyed or unreadable page never emits unmasked pixels. */ }
    finally { state.capturing = false; this.sync(); }
  }

  dispose() {
    for (const id of this.subscriptions.keys()) this.unsubscribe(id);
    this.fills.clear(); this.unbindWindow(); this.window = null;
  }
}
