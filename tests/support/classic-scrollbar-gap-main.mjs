// Renderer-only Electron host. No gateway, native views, or owner installation.
import { app, BrowserWindow, powerMonitor } from "electron";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

console.log("GAP_MAIN loaded");
app.setPath("userData", process.env.BUTLER_GAP_PROFILE);
const dist = resolve(process.env.BUTLER_SCROLLBAR_GAP_DIST ?? "packages/butler-app/client/ui/dist");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".png": "image/png", ".webp": "image/webp", ".json": "application/json" };
let fixture = {};
let replies = {};
let assets = {};
let window;
let locked = "unknown (no lock/unlock event observed)";
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      ({ fixture, replies, assets = {} } = JSON.parse(Buffer.concat(chunks).toString()));
      response.end("ok"); return;
    }
    if (url.pathname === "/__window") {
      window.setContentSize(Number(url.searchParams.get("width")), Number(url.searchParams.get("height")));
      response.end(JSON.stringify({ electron: process.versions.electron, shown: window.isVisible(), locked,
        size: window.getContentSize(), argv: process.argv })); return;
    }
    if (url.pathname === "/__zoom") {
      const factor = Number(url.searchParams.get("factor"));
      if (!Number.isFinite(factor) || factor <= 0) throw new Error("Invalid zoom factor");
      window.webContents.setZoomFactor(factor);
      await window.webContents.executeJavaScript(`document.documentElement.style.setProperty('--ui-scale', '${factor}')`);
      response.end(JSON.stringify({ factor: window.webContents.getZoomFactor(), size: window.getContentSize() })); return;
    }
    let file = resolve(dist, "." + decodeURIComponent(url.pathname));
    if (!file.startsWith(dist + sep) && file !== dist) throw new Error("outside dist");
    if (url.pathname === "/") file = resolve(dist, "index.html");
    if (await stat(file).then(value => value.isFile(), () => false)) {
      let body = await readFile(file);
      if (extname(file) === ".html") body = Buffer.from(body.toString().replace("<head>",
        `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture).replaceAll("<", "\\u003c")};for(const [k,v] of Object.entries(window.butlerConversationFixture.storage||{}))localStorage.setItem(k,v);if(window.__browserState&&Array.isArray(window.butlerConversationFixture.browserTabs))window.__browserState.tabs=window.butlerConversationFixture.browserTabs;</script>`));
      response.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
      response.end(body); return;
    }
    if (Object.hasOwn(assets, url.pathname)) {
      response.setHeader("Content-Type", assets[url.pathname].contentType);
      response.end(assets[url.pathname].body); return;
    }
    response.setHeader("Content-Type", "application/json");
    if (Object.hasOwn(replies, url.pathname)) response.end(JSON.stringify({ ok: true, data: replies[url.pathname] }));
    else { response.statusCode = 404; response.end(JSON.stringify({ ok: false, error: { code: "not_found" } })); }
  } catch (error) { response.statusCode = 500; response.end(String(error)); }
});
// Finish ESM evaluation before awaiting readiness: Electron waits for the entry
// module to finish loading before emitting ready.
app.whenReady().then(async () => {
  console.log("GAP_MAIN ready");
  powerMonitor.on("lock-screen", () => { locked = true; });
  powerMonitor.on("unlock-screen", () => { locked = false; });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  window = new BrowserWindow({ width: 1280, height: 860, useContentSize: true, show: true,
    webPreferences: { backgroundThrottling: false } });
  await window.loadURL("about:blank");
  console.log("GAP_HOST " + JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }));
}).catch(error => { console.error(error); app.exit(1); });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => server.close());
