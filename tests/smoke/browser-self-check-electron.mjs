// Real Electron output executor smoke; no UI or provider stubs.
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { loadavg } from "node:os";
import { writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkOutput } from "../../packages/butler-app/client/electron/browser/output-check.mjs";

app.setPath("userData", process.env.BUTLER_DATA);
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
// The product has its App window before checking outputs. Keep startup outside
// the check budget and retain the same native window/process model.
const appWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
await appWindow.loadURL("about:blank");
const runCheck = args => checkOutput(args, { kind: "output_check", content_origin: new URL(args.url).origin });
let fixed = false;
let requests = 0;
const server = createServer((request, response) => {
  requests++;
  response.setHeader("Content-Type", "text/html");
  if (request.url === "/__o/redirect") {
    response.writeHead(302, { location: "https://example.com/" });
    return response.end();
  }
  response.end(fixed ? "<!doctype html><title>Fixed</title><h1>Fixed</h1>" :
    "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><title>Fixture</title><style>body{margin:0}#wide{width:1290px}</style><h1 id='wide'>Output</h1><script>console.error('fixture console error');throw new Error('fixture exception')</script><img src='/missing.png'>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/__o/fixture`;
const delay = monitorEventLoopDelay({ resolution: 5 });
const loadAverage1mStart = loadavg()[0];
delay.enable();
try {
  const broken = await runCheck({ url, include_image: true, viewport: "mobile" });
  assert.equal(broken.status, "ok");
  assert.equal(broken.layout.overflow_px.mobile, 900);
  assert.equal(broken.layout.blank, false);
  assert(broken.errors.shown.some(message => message.includes("fixture console error")));
  assert(broken.errors.shown.some(message => message.includes("fixture exception")));
  assert(broken.warnings.includes("root_absolute_paths"));
  assert(broken.image.data);
  const image = Buffer.from(broken.image.data, "base64");
  assert(image.length <= 150 * 1024);
  const loadedRequests = requests;
  const cursor = await runCheck({ url, cursor: 1 });
  assert.equal(cursor.errors.total, broken.errors.total);
  assert.deepEqual(cursor.errors.shown, broken.errors.shown.slice(1));
  assert.equal(requests, loadedRequests, "cursor must use the original diagnostics");
  fixed = true;
  const repaired = await runCheck({ url });
  assert.equal(repaired.errors.total, 0);
  assert.deepEqual(repaired.layout, { blank: false, overflow_px: { desktop: 0, mobile: 0 } });
  const denied = await runCheck({ url: url.replace("fixture", "redirect") });
  assert.equal(denied.status, "navigation_denied");
  delay.disable();
  const p99 = delay.percentile(99) / 1e6;
  const loadAverage1mChecks = loadavg()[0];
  // Evidence I/O belongs outside the product-check timing window.
  writeFileSync(join(evidence, "mobile.jpg"), image);
  writeFileSync(join(evidence, "electron-checks.json"), JSON.stringify({ p99_ms: p99, loadAverage1mStart, loadAverage1m: loadAverage1mChecks, broken: { ...broken, image: { bytes: image.length } }, repaired, denied }, null, 2));
  assert(p99 <= 30, `main p99 ${p99}ms`);
  const snapshot = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = join(path, entry.name);
    return entry.isDirectory() ? snapshot(file) : [[file, statSync(file).size, statSync(file).mtimeMs]];
  }).sort();
  const partitions = join(process.env.BUTLER_DATA, "Partitions");
  const before = (() => { try { return snapshot(partitions); } catch { return []; } })();
  console.log(JSON.stringify({ phase: "checks_complete", p99_ms: p99, loadAverage1mStart, loadAverage1m: loadAverage1mChecks, mobile_overflow: 900, errors: broken.errors, image_bytes: image.length }));
  await new Promise(resolve => setTimeout(resolve, 600_000));
  const after = (() => { try { return snapshot(partitions); } catch { return []; } })();
  assert.deepEqual(after, before, "browser partition idle writes");
  writeFileSync(join(evidence, "electron.json"), JSON.stringify({ broken: { ...broken, image: { bytes: image.length } }, repaired, denied, p99_ms: p99, idle_seconds: 600, browser_owned_writes: 0, loadAverage1mStart, loadAverage1mChecks, loadAverage1mAfter: loadavg()[0] }, null, 2));
  console.log("Electron browser self-check passed; idle 600s, 0 partition writes");
} finally {
  server.close();
  appWindow.destroy();
}
app.quit();

}).catch(error => { console.error(error); app.exit(1); });
