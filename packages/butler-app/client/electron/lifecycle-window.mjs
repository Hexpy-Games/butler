import { app, ipcMain, nativeTheme, screen } from "electron";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findRendererDistRoot } from "./app-renderer-protocol.mjs";
import { readStartupAppearance, lifecycleAppearance } from "./startup-appearance.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const surfaces = new Map();
let bridgesInstalled = false;
function installBridges() {
  if (bridgesInstalled) return;
  bridgesInstalled = true;
  const owned = (event) => event.senderFrame === event.sender.mainFrame && surfaces.get(event.sender.id);
  ipcMain.handle("butler:lifecycle-state", (event) => owned(event)?.state());
  ipcMain.handle("butler:lifecycle-action", (event, action) => owned(event)?.action(action));
  ipcMain.on("butler:lifecycle-size", (event, height) => {
    const surface = owned(event);
    if (surface && Number.isInteger(height) && height >= 96 && height <= 500 && surface.window.getContentSize()[1] !== height) surface.window.setContentSize(296, height);
  });
  ipcMain.on("butler:lifecycle-painted", (event, profile) => owned(event)?.painted(profile));
}
export function lifecycleDist() {
  const dist = findRendererDistRoot([process.env.BUTLER_APP_RENDERER_DIST,
    join(process.resourcesPath, "app-client"), join(process.resourcesPath, "dist"),
    join(process.resourcesPath, "bundled-agent/resources/app-client/dist"),
    resolve(directory, "../ui/dist")]);
  if (!dist) throw new Error("lifecycle_assets_missing");
  return dist;
}
/** One static DS surface, created only when startup or Quit actually begins. */
export function createLifecycleWindow({ BrowserWindow, kind, bounds, locale, onAction, onPainted, timing = () => {} }) {
  installBridges();
  timing("appearance_read_start");
  const dist = lifecycleDist();
  const manifest = JSON.parse(readFileSync(join(dist, "lifecycle/manifest.json"), "utf8"));
  const appearance = lifecycleAppearance(readStartupAppearance(), manifest, nativeTheme.shouldUseDarkColors);
  const copy = JSON.parse(readFileSync(join(dist, "lifecycle/copy.json"), "utf8"));
  let state = { kind, stage: kind === "startup" ? "prepare" : "saving", ...appearance,
    locale: locale ?? appearance.locale ?? app.getLocale(), forceQuit: false, copy };
  timing("appearance_read_end");
  timing(`${kind}_create_start`);
  const window = new BrowserWindow({
    width: 296, height: manifest.initialHeight, useContentSize: true, frame: false, resizable: false,
    maximizable: false, fullscreenable: false, show: false, hasShadow: true,
    roundedCorners: true, closable: kind !== "quit", title: "Butler",
    backgroundColor: manifest.surface[appearance.theme],
    webPreferences: { preload: join(directory, "lifecycle-preload.cjs"), sandbox: true,
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, devTools: !app.isPackaged },
  });
  timing(`${kind}_create_end`);
  window.webContents.once("dom-ready", () => timing(`${kind}_dom_ready`));
  window.webContents.once("did-finish-load", () => timing(`${kind}_load_end`));
  const updateTitle = () => window.setTitle(copy[state.locale.startsWith("ko") ? "ko" : "en"][kind].title);
  updateTitle();
  const area = bounds ?? screen.getPrimaryDisplay().workArea;
  window.setPosition(Math.round(area.x + (area.width - 296) / 2), Math.round(area.y + (area.height - manifest.initialHeight) / 2));
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  timing(`${kind}_show_start`);
  window.show();
  timing(`${kind}_show_end`);
  let completed = false;
  const reveal = () => {
    if (completed || window.isDestroyed()) return;
    completed = true;
    window.webContents.setBackgroundThrottling(true); onPainted?.(window);
  };
  const surface = { window, state: () => state, action: (action) => onAction?.(action, state),
    painted(profile) { if (process.env.BUTLER_LIFECYCLE_PROFILE === "1") console.info(JSON.stringify({ lifecycleProfile: { kind, ...profile } })); timing(kind === "startup" ? "splash_painted" : "quit_painted"); reveal(); },
    update(next) { state = { ...state, ...next }; if (!window.isDestroyed()) { updateTitle(); window.webContents.send("butler:lifecycle-state", state); } },
    destroy() { if (!window.isDestroyed()) window.destroy(); } };
  surfaces.set(window.webContents.id, surface);
  const id = window.webContents.id;
  window.once("closed", () => surfaces.delete(id));
  window.once("ready-to-show", () => {
    timing(kind === "startup" ? "splash_ready_to_show" : "quit_ready_to_show");
  });
  timing(`${kind}_load_start`);
  void window.loadFile(join(dist, "lifecycle/lifecycle.html"), { query: {
    kind, stage: state.stage, locale: state.locale, theme: state.theme,
    motion: state.reducedMotion ? "reduced" : "auto",
  } }).catch(() => surface.update({ state: kind === "startup" ? "error" : "failed" }));
  return surface;
}
