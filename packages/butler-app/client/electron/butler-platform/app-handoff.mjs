import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

// The hidden browser host is the App's own executable. macOS keeps it out of
// the Dock, and LaunchServices routes a user's App launch (or a butler:// link)
// to it as an already running instance: the host then opens a separate, normal
// App instance and keeps serving until the Agent hands the channel over.
// Elsewhere a user's launch starts its own process; nothing to hand off.

export function hideFromDock(app, platform = process.platform) {
  if (platform === "darwin") app.dock?.hide();
}

export function handOffUserLaunches(app, platform = process.platform) {
  if (platform !== "darwin") return;
  let last = 0;
  const open = (url) => {
    if (Date.now() - last < 10_000) return;
    last = Date.now();
    // .../X.app/Contents/MacOS/X → .../X.app; a development Electron also needs its App directory.
    const bundle = resolve(dirname(process.execPath), "..", "..");
    const args = ["-n", "-a", bundle, ...(url ? [url] : []), ...(app.isPackaged ? [] : ["--args", app.getAppPath()])];
    spawn("/usr/bin/open", args, { detached: true, stdio: "ignore" }).unref();
  };
  app.on("activate", () => open());
  app.on("open-url", (event, url) => { event.preventDefault(); open(url); });
}
