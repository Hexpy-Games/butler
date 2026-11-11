import { ipcMain, WebContentsView } from "electron";
import { fileURLToPath } from "node:url";
import { overlaySession } from "./overlay-session.mjs";
import { fillOffer } from "./signin-autofill.mjs";

export class SignInSuggest {
  constructor(browser) {
    this.browser = browser;
    ipcMain.on("butler-browser:signin-field", (event, rect) => { void this.field(event, rect); });
    ipcMain.on("butler-browser:signin-field-gone", event => {
      const tab = [...browser.tabs.values()].find(item => item.view?.webContents === event.sender);
      if (tab) this.close(tab);
    });
    ipcMain.on("butler-browser:signin-suggest-pick", (event, entryId) => {
      if (event.sender === this.view?.webContents) void this.pick(this.tab, entryId);
    });
    ipcMain.on("butler-browser:signin-suggest-size", (event, height) => {
      if (event.sender !== this.view?.webContents || !Number.isFinite(height)) return;
      this.height = Math.max(4, Math.min(400, height)); this.sync(this.tab);
    });
  }
  async field(event, rect) {
    const browser = this.browser;
    const tab = [...browser.tabs.values()].find(item => item.view?.webContents === event.sender);
    const frame = event.senderFrame;
    if (!tab || !frame || tab.profile !== "signed_in" || tab.holder !== "user" || tab.saveOffer) return;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
    const url = tab.view.webContents.getURL();
    let origin;
    try { origin = new URL(url).origin; } catch { return; }
    if (frame.origin !== origin || tab.fillDismissed === url) return;
    if (tab.fillOffer?.url === url) { tab.fillOffer.rect = rect; this.sync(tab); return; }
    const accounts = await browser.signInAccounts?.(origin).catch(() => []);
    if (!accounts?.length || browser.tabs.get(tab.id) !== tab || tab.view.webContents.getURL() !== url) return;
    tab.fillOffer = { url, origin, accounts, rect, active: -1, error: false };
    this.sync(tab);
  }
  create() {
    this.view = new WebContentsView({ webPreferences: {
      session: overlaySession(), preload: fileURLToPath(new URL("./signin-suggest-preload.cjs", import.meta.url)),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    this.view.setBackgroundColor("#00000000");
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", event => event.preventDefault());
    contents.on("did-finish-load", () => { this.ready = true; this.sync(this.tab); });
    const host = this.browser.getWindow()?.webContents.getURL();
    const entry = new URL(host || "app://butler/index.html");
    entry.pathname = "/browser-overlay.html"; entry.search = ""; entry.hash = "signin";
    void contents.loadURL(entry.href).catch(() => { this.ready = false; });
  }
  sync(tab) {
    const browser = this.browser, win = browser.getWindow(), offer = tab?.fillOffer;
    const visible = offer && tab.url === offer.url && tab.id === browser.activeId && tab.attached === win &&
      browser.areaVisible && tab.slot?.visible && !tab.covered && !tab.dialog && browser.nativeCovers === 0 && tab.holder === "user";
    if (!visible) { this.hide(); return; }
    if (this.tab !== tab) this.hide();
    this.tab = tab;
    if (!this.view) { this.create(); win.contentView.addChildView(this.view); this.attached = win; }
    const z = tab.view.webContents.getZoomFactor(), b = tab.view.getBounds(), rect = offer.rect;
    const width = Math.min(b.width, Math.max(rect.width * z, 240));
    const height = Math.min(b.height, this.height ?? offer.accounts.length * 36 + 8);
    const left = b.x + rect.x * z;
    let top = b.y + (rect.y + rect.height) * z + 4;
    if (top + height > b.y + b.height) top = b.y + rect.y * z - 4 - height;
    this.view.setBounds({ x: Math.round(Math.max(b.x, Math.min(left, b.x + b.width - width))),
      y: Math.round(Math.max(b.y, Math.min(top, b.y + b.height - height))), width: Math.round(width), height: Math.ceil(height) });
    if (!this.ready) return;
    const frame = { locale: browser.pointer.presentation?.locale, accounts: offer.accounts.map(({ id, username }) => ({ id, username })), active: offer.active, error: offer.error };
    const serialized = JSON.stringify(frame);
    if (serialized !== this.lastFrame) { this.lastFrame = serialized; this.view.webContents.send("butler-browser:signin-suggest", frame); }
  }
  hide() {
    if (this.attached && !this.attached.isDestroyed()) this.attached.contentView.removeChildView(this.view);
    this.view?.webContents.close();
    this.view = null; this.tab = null; this.attached = null; this.ready = false; this.lastFrame = null; this.height = undefined;
  }
  close(tab) {
    tab.fillOffer = null;
    if (this.tab === tab) this.hide();
  }
  async pick(tab, entryId) {
    const offer = tab?.fillOffer;
    if (!offer) return;
    const result = await fillOffer(this.browser, tab.id, entryId);
    if (result.ok) { this.close(tab); tab.view.webContents.focus(); }
    else if (tab.fillOffer === offer) { offer.error = true; this.sync(tab); }
  }
  key(tab, input) {
    const offer = tab.fillOffer;
    if (input.type !== "keyDown" || this.tab !== tab || !this.view || !offer) return false;
    if (input.key === "Escape") { tab.fillDismissed = offer.url; this.close(tab); return true; }
    if (offer.error) return false;
    if (["ArrowDown", "ArrowUp"].includes(input.key)) {
      offer.active = (offer.active + (input.key === "ArrowDown" ? 1 : offer.active < 0 ? 0 : -1) + offer.accounts.length) % offer.accounts.length;
      this.sync(tab); return true;
    }
    if (input.key === "Enter" && offer.active >= 0) { void this.pick(tab, offer.accounts[offer.active].id); return true; }
    return false;
  }
}
