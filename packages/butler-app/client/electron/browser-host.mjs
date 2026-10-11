// The hidden browser host: this App's Electron serving Butler's browser tools
// while the App itself is not running. The Agent starts it on first need with
// `--butler-browser-host=<throwaway profile>`; it shows no window, tray or Dock
// icon, runs the App's own executor over the App's browser-host channel, and
// quits when the Agent closes that channel (idle reap, the App taking over,
// or the Agent ending).
import { createRequire } from "node:module";
import { handOffUserLaunches, hideFromDock } from "./butler-platform/app-handoff.mjs";

const FLAG = "--butler-browser-host=";
const VARIABLES = ["URL", "TOKEN", "ADMIN", "LAUNCH"].map(name => `BUTLER_BROWSER_HOST_${name}`);
// Read once; no renderer, helper or child process inherits the credentials.
const [url, token, admin, launch] = VARIABLES.map(name => process.env[name] ?? "");
for (const name of VARIABLES) delete process.env[name];
const profile = process.argv.find(arg => arg.startsWith(FLAG))?.slice(FLAG.length) ?? "";

const { app } = createRequire(import.meta.url)("electron");
if (!profile || !url || !token || !admin || !launch) {
  console.error("[browser-host] launched without its channel");
  app.exit(2);
} else {
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  // A throwaway profile: no keychain item, nothing for a password store.
  app.commandLine.appendSwitch("use-mock-keychain");
  app.commandLine.appendSwitch("password-store", "basic");
  hideFromDock(app);
  handOffUserLaunches(app);
  // Agent tabs come and go; the channel alone decides the host's lifetime.
  app.on("window-all-closed", () => {});
  void app.whenReady().then(serve).catch((error) => {
    console.error("[browser-host] start failed:", error?.stack ?? String(error));
    app.exit(1);
  });
}

async function serve() {
  const { Menu } = createRequire(import.meta.url)("electron");
  Menu.setApplicationMenu(null);
  const { installUserBrowser } = await import("./browser/ipc.mjs");
  const { createBrowserHost } = await import("./browser/host-channel.mjs");
  const browser = installUserBrowser(app, () => null);
  if (!browser.enabled()) {
    console.error("[browser-host] browsing is not available in this build");
    app.exit(3);
    return;
  }
  const request = (path, init = {}) => fetch(new URL(path, url), { ...init,
    headers: { authorization: `Bearer ${token}`, "x-butler-browser-host": launch, ...init.headers } });
  const host = createBrowserHost({
    fetch: request,
    adminCredential: () => admin,
    executeBrowser: frame => browser.execute(frame),
    resetBrowser: () => browser.resetUse(),
    snapshot: () => browser.snapshot(),
    enabled: () => browser.enabled(),
    onClosed: quit,
  });
  browser.onState = () => host.changed();
  browser.downloadRequest = async input => {
    const response = await request("/internal/browser-host/downloads", { method: "POST",
      headers: { "content-type": "application/json", "x-butler-admin": admin }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error("download_request_failed");
    return response.json();
  };
  host.start();
}

function quit() {
  // The browser's will-quit flush closes every tab first; never linger after that.
  setTimeout(() => app.exit(0), 5000).unref();
  app.quit();
}
