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
  ipcMain.on("butler:lifecycle-painted", (event) => owned(event)?.painted());
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
  const appearance = lifecycleAppearance(readStartupAppearance(), dist, app.getPath("userData"), nativeTheme.shouldUseDarkColors);
  const copy = JSON.parse(readFileSync(join(dist, "lifecycle/copy.json"), "utf8"));
  let state = { kind, stage: kind === "startup" ? "prepare" : "saving", ...appearance,
    locale: locale ?? appearance.locale ?? app.getLocale(), forceQuit: false, copy };
  timing("appearance_read_end");
  const window = new BrowserWindow({
    width: 360, height: 264, useContentSize: true, frame: false, resizable: false,
    maximizable: false, fullscreenable: false, show: false, hasShadow: true,
    roundedCorners: true, closable: kind !== "quit", title: "Butler",
    backgroundColor: appearance.averageColor ?? manifest.surfaceBase[appearance.theme],
    webPreferences: { preload: join(directory, "lifecycle-preload.cjs"), sandbox: true,
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, devTools: !app.isPackaged },
  });
  const updateTitle = () => window.setTitle(copy[state.locale.startsWith("ko") ? "ko" : "en"][kind].title);
  updateTitle();
  const area = bounds ?? screen.getPrimaryDisplay().workArea;
  window.setPosition(Math.round(area.x + (area.width - 360) / 2), Math.round(area.y + (area.height - 264) / 2));
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  let shown = false;
  let fallback;
  const reveal = () => {
    if (shown || window.isDestroyed()) return;
    shown = true; clearTimeout(fallback); window.show();
    window.webContents.setBackgroundThrottling(true); onPainted?.(window);
  };
  const surface = { window, state: () => state, action: (action) => onAction?.(action, state),
    painted() { timing(kind === "startup" ? "splash_painted" : "quit_painted"); reveal(); },
    update(next) { state = { ...state, ...next }; if (!window.isDestroyed()) { updateTitle(); window.webContents.send("butler:lifecycle-state", state); } },
    destroy() { clearTimeout(fallback); if (!window.isDestroyed()) window.destroy(); } };
  surfaces.set(window.webContents.id, surface);
  const id = window.webContents.id;
  window.once("closed", () => { clearTimeout(fallback); surfaces.delete(id); });
  window.once("ready-to-show", () => {
    timing(kind === "startup" ? "splash_ready_to_show" : "quit_ready_to_show");
    if (kind === "startup") fallback = setTimeout(() => { timing("splash_forced_show"); reveal(); }, 300);
  });
  void window.loadFile(join(dist, "lifecycle/lifecycle.html"), { query: {
    kind, stage: state.stage, locale: state.locale, theme: state.theme,
    motion: state.reducedMotion ? "reduced" : "auto", ...(appearance.still ? { still: appearance.still } : {}),
  } }).catch(() => surface.update({ state: kind === "startup" ? "error" : "failed" }));
  return surface;
}
