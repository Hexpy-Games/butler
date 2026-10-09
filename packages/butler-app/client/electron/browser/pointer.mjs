import { WebContentsView } from "electron";
import { fileURLToPath } from "node:url";
import { tabInUse } from "./usage.mjs";

const MODES = new Set(["observe", "click", "type", "scroll", "batch", "parked"]);
const MOUSE = new Set(["mouseDown", "mouseUp", "mouseMove", "mouseEnter", "mouseLeave", "mouseWheel"]);

/** One transparent presenter above the page; capturePage on tab.view never captures it. */
export class BrowserPointer {
  constructor(browser, takeOver) { this.browser = browser; this.takeOver = takeOver; }
  action(tab, event) {
    if (!tab || !MODES.has(event?.mode)) return;
    const target = event.mode === "observe" ? { x: 0, y: 0, width: tab.agent ? 1280 : tab.bounds?.width ?? 1280, height: tab.agent ? 800 : tab.bounds?.height ?? 800 } : undefined;
    tab.pointer = { mode: event.mode, at: tab.pointer?.at ?? { x: 64, y: 64 }, target, steps: [] };
    this.sync(tab);
  }
  step(tab, step, target) {
    if (!tab.pointer || ![target.x, target.y].every(Number.isFinite)) return;
    const at = { x: target.x, y: target.y };
    const previous = tab.pointer;
    const mode = previous.mode === "batch" ? "batch" : step.action === "fill" ? "type" : step.action === "scroll" ? "scroll" : step.action === "hover" ? "observe" : "click";
    // Refined geometry comes only from the dispatch hit-test; values never enter the overlay.
    tab.pointer = { mode, at, from: previous.at, steps: [...previous.steps, at], value: step.action === "fill" ? "••••" : undefined, target: target.rect };
    this.sync(tab);
  }
  hide() {
    if (this.attached && !this.attached.isDestroyed()) this.attached.contentView.removeChildView(this.view);
    this.attached = null;
  }
  create() {
    if (this.view) return;
    this.view = new WebContentsView({ webPreferences: {
      preload: fileURLToPath(new URL("./overlay-preload.cjs", import.meta.url)),
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: true,
    } });
    this.view.setBackgroundColor("#00000000");
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.on("input-event", (_event, input) => this.mouse(input));
    contents.on("before-input-event", (event, input) => {
      event.preventDefault();
      const tab = this.tab();
      if (!this.acceptInput(tab, input.type === "keyDown")) return;
      const modifiers = ["shift", "control", "alt", "meta"].filter((key) => input[key]);
      tab.view.webContents.sendInputEvent({ type: input.type, keyCode: input.key, modifiers });
    });
    contents.on("did-finish-load", () => { this.ready = true; this.lastFrame = null; this.sync(this.tab()); });
    const host = this.browser.getWindow()?.webContents.getURL();
    const entry = new URL(host || "app://butler/index.html");
    entry.pathname = "/browser-overlay.html"; entry.search = ""; entry.hash = "";
    void contents.loadURL(entry.href).catch(() => { this.ready = false; });
  }
  tab() { return this.browser.tabs.get(this.browser.activeId); }
  acceptInput(tab, takeOver = false) {
    if (!tab?.view || tab.view.webContents.isDestroyed()) return false;
    if (tab.holder === "agent" && (tab.busy || tabInUse(this.browser, tab))) return false;
    if (takeOver && tab.holder === "agent") this.takeOver(this.browser, tab, "user");
    return true;
  }
  mouse(input) {
    const tab = this.tab();
    if (MOUSE.has(input.type) && this.acceptInput(tab, input.type === "mouseDown")) {
      if (input.type === "mouseDown") tab.view.webContents.focus();
      tab.view.webContents.sendInputEvent(input);
    }
  }
  sync(tab) {
    const win = this.browser.getWindow();
    const visible = tab?.pointer && tab.owner !== "mine" && tab.attached === win && this.browser.areaVisible &&
      tab.bounds?.visible && !tab.covered && !this.browser.nativeCovers && tab.status !== "crashed";
    if (!visible) { this.hide(); return; }
    this.create();
    // The native input guard must exist even before the presenter has loaded.
    if (this.attached !== win) { this.hide(); win.contentView.addChildView(this.view); this.attached = win; }
    const bounds = tab.view.getBounds(); this.view.setBounds(bounds); this.view.setBorderRadius(tab.bounds.radius ?? 0);
    if (!this.ready) return;
    const scale = tab.bounds.scale ?? 1, point = (p) => ({ x: p.x * scale, y: p.y * scale });
    const parked = tab.holder === "user" || tab.waiting;
    const frame = { ...tab.pointer, mode: parked ? "parked" : tab.pointer.mode, tone: tab.waiting ? "waiting" : "default",
      at: tab.holder === "user" && !tab.waiting ? { x: 20, y: bounds.height - 44 } : point(tab.pointer.at),
      from: !parked && tab.pointer.from ? point(tab.pointer.from) : undefined,
      steps: !parked ? tab.pointer.steps.map(point) : [],
      target: tab.pointer.target ? { ...point(tab.pointer.target), width: tab.pointer.target.width * scale, height: tab.pointer.target.height * scale } : undefined,
      width: bounds.width, height: bounds.height, ...this.presentation };
    const serialized = JSON.stringify(frame);
    if (serialized !== this.lastFrame) { this.lastFrame = serialized; this.view.webContents.send("butler-browser:overlay", frame); }
  }
  present(input) {
    this.presentation = { locale: input.locale === "ko-KR" ? "ko-KR" : "en-US", reducedMotion: input.reducedMotion === true };
    this.sync(this.tab());
  }
  dispose() { this.hide(); this.view?.webContents.close({ waitForBeforeUnload: false }); this.view = null; }
}
