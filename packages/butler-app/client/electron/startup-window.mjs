import { app, BrowserWindow, ipcMain, nativeTheme, dialog } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRendererDistRoot } from "./app-renderer-protocol.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const createdAt = process.getCreationTime();
const startedAt = createdAt === null ? null : performance.now() - (Date.now() - createdAt);
const events = [];
let window = null;
let timer;
let state = { stage: "starting", failed: false };
let actions = {};
let readyResolve;
const rendererReady = new Promise((resolve) => { readyResolve = resolve; });
let rendererId;
let preferencesReady = Promise.resolve();

export function startupTimings() { return events.map((event) => ({ ...event })); }

export function startupTiming(stage) {
  events.push({ stage, elapsed_ms: startedAt === null ? null : Math.round(performance.now() - startedAt) });
  console.info(JSON.stringify({ startup: events.at(-1) }));
}

function publish() {
  if (window && !window.isDestroyed()) window.webContents.send("butler:startup-state", state);
}

export function startupStage(stage) {
  if (state.failed || !window) return;
  clearTimeout(timer);
  state = { ...state, stage };
  startupTiming(stage);
  publish();
  timer = setTimeout(() => failStartup(), stage === "agent" ? 120_000 : 30_000);
}

export function failStartup() {
  clearTimeout(timer);
  state = { ...state, failed: true };
  startupTiming("failed");
  publish();
  return Boolean(window && !window.isDestroyed());
}

export function configureStartupActions(next) { actions = next; }

export function waitForStartupRenderer(win) {
  rendererId = win.webContents.id;
  const failWhileStarting = () => { if (window) failStartup(); };
  win.webContents.once("render-process-gone", failWhileStarting);
  win.webContents.once("did-fail-load", failWhileStarting);
  return rendererReady;
}

export function isStartupWindow(win) { return win === window; }

export function startupPending() { return Boolean(window); }

export function completeStartup(win, show = true) {
  if (state.failed) return false;
  clearTimeout(timer);
  if (show) win.show();
  startupTiming("ready");
  window?.destroy();
  window = null;
  return true;
}

export function createStartupWindow() {
  startupTiming("app_ready");
  // Common flags only: no OS-specific window policy outside butler-platform.
  window = new BrowserWindow({
    width: 340, height: 280, frame: false, resizable: false, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1f2023" : "#f8f9fa",
    webPreferences: { preload: join(directory, "startup-preload.cjs"), sandbox: true,
      contextIsolation: true, nodeIntegration: false },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("closed", () => { clearTimeout(timer); window = null; });
  window.show();
  startupTiming("splash_shown");
  window.once("ready-to-show", () => startupTiming("splash_first_frame"));
  ipcMain.handle("butler:startup-state", (event) => {
    if (event.sender !== window?.webContents) return null;
    return preferencesReady.then(() => ({ ...state, language: app.getLocale() }));
  });
  ipcMain.handle("butler:startup-action", async (event, action) => {
    if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !state.failed) return;
    if (action === "retry") { app.relaunch(); app.quit(); }
    if (action === "logs") {
      if (actions.logs) await actions.logs(events);
      else {
        const result = await dialog.showSaveDialog({ defaultPath: "butler-startup-diagnostics.json" });
        if (!result.canceled && result.filePath) await writeFile(result.filePath, JSON.stringify({ state, events }), { mode: 0o600 });
      }
    }
  });
  ipcMain.on("butler:startup-painted", (event) => {
    if (event.sender === window?.webContents && event.senderFrame === event.sender.mainFrame) startupTiming("splash_painted");
  });
  ipcMain.on("butler:renderer-ready", (event) => {
    if (window && event.sender.id === rendererId && event.senderFrame === event.sender.mainFrame) {
      startupTiming("renderer_data_painted");
      readyResolve();
    }
  });
  installMotionPreferenceBridge();
  const dist = findRendererDistRoot([
    process.env.BUTLER_APP_RENDERER_DIST,
    join(process.resourcesPath, "app-client"), join(process.resourcesPath, "dist"),
    join(process.resourcesPath, "bundled-agent/resources/app-client/dist"),
    join(process.resourcesPath, "bundled-agent/packages/butler-agent/resources/app-client/dist"),
    resolve(directory, "../ui/dist"),
  ]);
  startupStage("starting");
  if (dist) void window.loadFile(join(dist, "startup.html")).catch(failStartup);
  else if (process.env.BUTLER_APP_UI_URL) {
    void window.loadURL(new URL("startup.html", process.env.BUTLER_APP_UI_URL).href).catch(failStartup);
  } else { failStartup(); }
}

function installMotionPreferenceBridge() {
  const file = join(app.getPath("userData"), "startup-preferences.json");
  preferencesReady = readFile(file, "utf8").then((text) => {
    state = { ...state, reducedMotion: JSON.parse(text).reducedMotion === true };
    publish();
  }).catch(() => undefined);
  ipcMain.on("butler:startup-motion", (event, reducedMotion) => {
    if (event.sender.id !== rendererId || event.senderFrame !== event.sender.mainFrame || typeof reducedMotion !== "boolean") return;
    void mkdir(dirname(file), { recursive: true }).then(() =>
      writeFile(file, JSON.stringify({ reducedMotion }), { mode: 0o600 })).catch(() => undefined);
  });
}
