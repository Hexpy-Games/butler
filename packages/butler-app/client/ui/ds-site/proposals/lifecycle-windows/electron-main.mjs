// Electron main for electron-preview.mjs (proposal tooling only). Serves the built DS site on a
// loopback port and opens each lifecycle window at its real size.
import { app, BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const dist = option("dist");
const which = option("window", "both");
const [WIDTH, HEIGHT] = [360, 264];
// DS --color-surface-base per theme: the native colour before the first paint (no white flash).
const SURFACE = { light: "#f8f9fa", dark: "#1f2023" };
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json", ".svg": "image/svg+xml",
  ".frag": "text/plain", ".txt": "text/plain" };

function serve() {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://localhost").pathname)).replace(/^([/\\])+/u, "");
    let file = join(dist, path || "index.html");
    if (!file.startsWith(dist)) { response.writeHead(403).end(); return; }
    try { if (statSync(file).isDirectory()) file = join(file, "index.html"); } catch { file = join(dist, "index.html"); }
    response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

app.whenReady().then(async () => {
  const port = await serve();
  const theme = option("theme", nativeTheme.shouldUseDarkColors ? "dark" : "light");
  const query = { proposal: "lifecycle-windows", theme };
  for (const key of ["startup", "quit", "wallpaper", "locale", "motion", "backdrop", "force", "surface"]) {
    const value = option(key);
    if (value) query[key] = value;
  }
  const kinds = which === "both" ? ["startup", "quit"] : [which];
  const area = screen.getPrimaryDisplay().workArea;
  const [width, height] = [WIDTH, HEIGHT];
  kinds.forEach((kind, index) => {
    const offset = kinds.length === 1 ? 0 : (index === 0 ? -1 : 1) * (width / 2 + 24);
    const win = new BrowserWindow({
      width, height, useContentSize: true,
      x: Math.round(area.x + area.width / 2 - width / 2 + offset), y: Math.round(area.y + area.height / 2 - height / 2),
      frame: false, resizable: false, maximizable: false, fullscreenable: false, show: false,
      hasShadow: true, roundedCorners: true, backgroundColor: SURFACE[theme] ?? SURFACE.light,
      title: kind === "startup" ? "Butler" : "Butler",
      webPreferences: { preload: join(here, "electron-preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const smoke = option("smoke");
    if (smoke) {
      // Self-check without showing anything: capture each hidden window once, then quit.
      win.webContents.once("did-finish-load", () => setTimeout(async () => {
        const image = await win.webContents.capturePage();
        const { writeFileSync } = await import("node:fs");
        writeFileSync(join(smoke, `electron-${kind}.png`), image.toPNG());
        console.log(`[smoke] ${kind} ${image.getSize().width}x${image.getSize().height} title=${win.webContents.getTitle()}`);
        win.destroy();
      }, 2000));
      void win.loadURL(`http://127.0.0.1:${port}/?${new URLSearchParams({ ...query, stage: kind })}`);
      return;
    }
    // Reveal after the first paint plus a beat for the wallpaper still (the product waits for decode instead).
    win.once("ready-to-show", () => setTimeout(() => win.show(), 120));
    void win.loadURL(`http://127.0.0.1:${port}/?${new URLSearchParams({ ...query, stage: kind })}`);
  });
  console.log(`Lifecycle windows open (${kinds.join(", ")}, ${theme}). Keys: arrows state, F force-quit flag, T theme, W wallpaper, S surface, L language, M motion, B backdrop, P play, Q quit.`);
});

ipcMain.on("lifecycle-preview:action", (_event, name) => {
  if (name === "quit") app.quit();
  else console.log(`[preview] action: ${name} (product: ${name === "retry" ? "app.relaunch()" : name === "log" ? "reveal the diagnostics file" : "force stop, needs supervisor support"})`);
});

app.on("window-all-closed", () => app.quit());
