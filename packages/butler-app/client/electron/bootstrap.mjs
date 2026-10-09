import "./stdio-errors.mjs";
// Only Electron/Node and the small startup surface load before the first window.
import { createRequire } from "node:module";
import { APP_RENDERER_SCHEME_PRIVILEGES } from "./app-renderer-protocol.mjs";
import { startupTiming } from "./startup-timing.mjs";
import { configureChromiumFeatures } from "./butler-platform/chromium-features.mjs";

// Electron's ESM facade evaluates every API getter, including nativeTheme.
// Keep it unloaded until ready, after Chromium rebuilds its feature list.
const { app, protocol } = createRequire(import.meta.url)("electron");
configureChromiumFeatures(app.commandLine);
let failStartup = () => false;

protocol.registerSchemesAsPrivileged([APP_RENDERER_SCHEME_PRIVILEGES]);
startupTiming("entry");
// A web tab GPU reset must not block the trusted App origin from restoring WebGL.
// Chromium 152 has no per-origin exemption; the Browser five-loss breaker remains.
app.commandLine.appendSwitch("disable-domain-blocking-for-3d-apis");
app.once("will-finish-launching", () => startupTiming("will_finish_launching"));
app.setName("Butler");
if (process.env.BUTLER_E2E_TIER === "stub" && process.env.BUTLER_APP_SMOKE_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", process.env.BUTLER_APP_SMOKE_DEBUG_PORT);
}
const backgroundLaunch = process.argv.some((arg) =>
  ["--squirrel-install", "--squirrel-updated", "--squirrel-uninstall", "--squirrel-obsolete",
    "--butler-menu-bar-helper", "--butler-quit-main-ui",
    "--butler-quit-menu-bar-helper"].includes(arg));
if (process.env.BUTLER_APP_ELECTRON_USER_DATA_DIR) {
  app.setPath("userData", process.env.BUTLER_APP_ELECTRON_USER_DATA_DIR);
}
if (backgroundLaunch) {
  await import("./main.mjs");
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Do not top-level-await ready: Electron waits for ESM evaluation before ready.
  void app.whenReady().then(async () => {
    startupTiming("app_ready");
    const startup = await import("./startup-window.mjs");
    failStartup = startup.failStartup;
    const { createStartupWindow } = startup;
    await createStartupWindow();
    setImmediate(() => {
      startupTiming("runtime_import_start");
      void import("./main.mjs").then(() => startupTiming("runtime_imported")).catch(failStartup);
    });
  }).catch(() => { if (!failStartup()) app.quit(); });
}
