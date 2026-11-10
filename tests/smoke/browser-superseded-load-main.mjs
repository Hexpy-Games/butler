// A load superseded by the page's own redirect, torn down the way the App's handler does.
import { app, BrowserWindow } from "electron";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const out = process.env.SUPERSEDED_LOAD_OUT;
setTimeout(() => { writeFileSync(out, JSON.stringify({ error: "hard stop" })); app.exit(3); }, 30_000);

app.dock?.hide();
const server = createServer((req, res) => {
  if (req.url === "/a") {
    res.setHeader("Content-Type", "text/html");
    return res.end(`<!doctype html><img src="/slow"><script>setTimeout(() => { location.href = "/b"; }, 200)</script>`);
  }
  if (req.url === "/slow") return void setTimeout(() => { res.setHeader("Content-Type", "image/gif"); res.end(); }, 5000);
  res.setHeader("Content-Type", "text/html");
  return res.end("<!doctype html><title>b</title>");
});
// An ESM entry's top-level await holds back "ready", so the scenario runs from it.
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { loadOutsideNavigation } = await import(`${process.env.SUPERSEDED_LOAD_BROWSER_DIR}/settled-load.mjs`);
  const win = new BrowserWindow({ show: false });
  let result;
  try {
    await loadOutsideNavigation(win.webContents, base + "/a");
    result = { code: "loaded" };
  } catch (error) {
    result = { code: error.code };
    win.webContents.stop();
    win.destroy();
  }
  writeFileSync(out, JSON.stringify(result));
  server.close();
  app.exit(0);
});
