// Real Electron element-picking fixtures: hit-testing, granularity, crops and area capture.
// Run: BUTLER_DATA=$(mktemp -d) BUTLER_BROWSER_EVIDENCE=<dir> <electron 44> tests/smoke/browser-pick-electron.mjs
import { app, BrowserWindow, WebContentsView, nativeImage, screen } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { areas, cases, pages } from "../support/browser-pick-fixtures.mjs";
import { attachNativeWorlds } from "../../packages/butler-app/client/electron/browser/native-worlds.mjs";

const browserDir = new URL("../../packages/butler-app/client/electron/browser/", import.meta.url);
const { BrowserSelection } = await import(new URL(process.env.BUTLER_PICK_SELECTION ?? "selection.mjs", browserDir).href);
const reportOnly = process.env.BUTLER_PICK_REPORT_ONLY === "1";
app.setPath("userData", process.env.BUTLER_DATA);
// A second site for cross-site (out-of-process) iframes without leaving loopback.
app.commandLine.appendSwitch("host-resolver-rules", "MAP cross.test 127.0.0.1");
app.on("window-all-closed", () => {});

const near = (a, b, tolerance = 2) => a && b && ["x", "y", "width", "height"].every(key => Math.abs(a[key] - b[key]) <= tolerance);
const round = rect => rect && Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value)]));

app.whenReady().then(async () => {
  const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence, "BUTLER_BROWSER_EVIDENCE required");
  mkdirSync(evidence, { recursive: true });
  const server = createServer((request, response) => {
    const name = request.url.split("?")[0].slice(1);
    const html = name === "frames" ? pages.frames(`http://cross.test:${server.address().port}`) : pages[name];
    response.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" }); response.end(html ?? "");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({ width: 1000, height: 700, useContentSize: true, show: false, webPreferences: { sandbox: true } });
  const view = new WebContentsView({ webPreferences: { preload: fileURLToPath(new URL("page-controls.cjs", browserDir)),
    nodeIntegrationInSubFrames: true, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  // Captures need a composited, unoccluded view; keep the fixture window above others without focus.
  win.setAlwaysOnTop(true, "floating"); win.showInactive();
  const tab = { id: "pick", view, epoch: 1, bounds: { scale: 1 }, selections: [], owner: "mine", picking: true };
  attachNativeWorlds(tab);
  const browser = { tabs: new Map([[tab.id, tab]]), activeId: tab.id, publish() {}, sync() {}, getWindow: () => win,
    pointer: { acceptInput: () => true, sync() {}, inputFailed() {}, view: null } };
  const selection = new BrowserSelection(browser);
  const fresh = typeof selection.hoverAt === "function";
  const dpr = screen.getPrimaryDisplay().scaleFactor;
  const contents = view.webContents;

  async function load(name) {
    tab.url = `${origin}/${name}`; tab.epoch++; tab.selections = []; tab.pickHover = null; selection.preferred = null;
    await contents.loadURL(tab.url);
    const frames = name === "frames" ? 3 : 1;
    for (let i = 0; i < 100; i++) {
      const ready = await contents.executeJavaScript("window.__ready === true && document.readyState === 'complete'");
      const live = [...tab.nativeFrames.values()].filter(frame => !frame.isDestroyed() && !frame.detached).length;
      if (ready && live >= frames) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    // The first capture after a load can precede the view's first composited frame.
    for (let i = 0; i < 40; i++) {
      const probe = await Promise.race([contents.capturePage({ x: 0, y: 0, width: 4, height: 4 }).catch(() => null), new Promise(resolve => setTimeout(resolve, 500))]);
      if (probe && !probe.isEmpty()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  /** Element rect in main-viewport CSS pixels, walking named iframes. */
  async function rectOf({ frames, el, clip }) {
    let frame = contents.mainFrame, x = 0, y = 0;
    for (const name of frames) {
      const box = await frame.executeJavaScript(`(()=>{const f=document.querySelector('iframe[name="${name}"]'),r=f.getBoundingClientRect(),s=getComputedStyle(f);
        return {x:r.x+f.clientLeft+parseFloat(s.paddingLeft),y:r.y+f.clientTop+parseFloat(s.paddingTop)}})()`);
      x += box.x; y += box.y; frame = frame.frames.find(child => child.name === name);
    }
    const r = await frame.executeJavaScript(`(()=>{const v={left:0,top:0,right:document.documentElement.clientWidth,bottom:document.documentElement.clientHeight};
      const r=(${el}).getBoundingClientRect(),c=${clip ? `(${clip})` : "null"};const k=c?c.getBoundingClientRect():null;
      const box=k?{left:k.left+c.clientLeft,top:k.top+c.clientTop,right:k.left+c.clientLeft+c.clientWidth,bottom:k.top+c.clientTop+c.clientHeight}:v;
      const l=Math.max(r.left,v.left,box.left),t=Math.max(r.top,v.top,box.top),R=Math.min(r.right,v.right,box.right),B=Math.min(r.bottom,v.bottom,box.bottom);
      return {x:l,y:t,width:R-l,height:B-t}})()`);
    return { ...r, x: r.x + x, y: r.y + y };
  }
  async function pointOf(at) {
    if (Number.isFinite(at.x) && !at.el) return { x: at.x, y: at.y };
    const r = await rectOf({ frames: at.frames, el: at.el });
    return { x: Math.round(r.x + r.width * at.fx + at.dx), y: Math.round(r.y + r.height * at.fy + at.dy) };
  }
  /** Masked fields must be one flat fill in the crop (no field pixels). */
  async function maskedFill(item, frames, selector) {
    const field = await rectOf({ frames, el: `document.querySelector(${JSON.stringify(selector)})` });
    const image = nativeImage.createFromDataURL(item.crop), size = image.getSize(), bitmap = image.toBitmap();
    const fx = size.width / item.cropRect.width, fy = size.height / item.cropRect.height;
    const samples = [[0.2, 0.5], [0.5, 0.5], [0.8, 0.5]].map(([px, py]) => {
      const x = Math.floor((field.x + field.width * px - item.cropRect.x) * fx), y = Math.floor((field.y + field.height * py - item.cropRect.y) * fy);
      const offset = (y * size.width + x) * 4; return [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2]];
    });
    return samples.every(sample => sample.every(value => Math.abs(value - samples[0][0]) <= 12));
  }
  function cropMatches(item) {
    if (!item?.crop?.startsWith("data:image/jpeg;base64,")) return false;
    const size = nativeImage.createFromDataURL(item.crop).getSize();
    const inside = item.cropRect.x >= item.rect.x - 1 && item.cropRect.y >= item.rect.y - 1 &&
      item.cropRect.x + item.cropRect.width <= item.rect.x + item.rect.width + 1 && item.cropRect.y + item.cropRect.height <= item.rect.y + item.rect.height + 1;
    return inside && Math.abs(size.width - item.cropRect.width * dpr) <= 2 * dpr + 1 && Math.abs(size.height - item.cropRect.height * dpr) <= 2 * dpr + 1;
  }

  const rows = [];
  let current = "";
  for (const test of cases) {
    if (current !== test.page) { await load(test.page); current = test.page; }
    selection.preferred = null;
    if (process.env.BUTLER_PICK_TRACE) console.log(`case ${test.id}`);
    const point = await pointOf(test.at), target = await rectOf(test.target);
    const row = { id: test.id, point, target: round(target) };
    let item = null;
    if (fresh) {
      await selection.hoverAt(tab, point);
      const hover = tab.pickHover, levels = hover?.levels ?? [];
      const found = levels.findIndex(level => near(level.rect, target));
      row.ladder = levels.map(level => `${level.name}${round(level.rect).width}x${round(level.rect).height}`);
      row.defaultLevel = row.ladder[hover?.index] ?? null; row.label = hover?.label;
      row.steps = found < 0 ? null : found - hover.index;
      row.hovered = found >= 0 && (test.steps >= 0 ? row.steps >= 0 && row.steps <= test.steps : row.steps <= 0 && row.steps >= test.steps);
      if (row.hovered) {
        for (let i = 0; i < Math.abs(row.steps); i++) selection.step(tab, Math.sign(row.steps));
        assert.ok(near(tab.pickHover.rect, target), `${test.id}: stepped hover outline`);
        item = await selection.hit(tab, point);
      }
    } else {
      const hover = await selection.read(tab, point).catch(error => ({ error: String(error) }));
      row.leaf = hover ? `${hover.tag ?? hover.error}${hover.rect ? ` ${round(hover.rect).width}x${round(hover.rect).height}` : ""}` : null;
      row.hovered = near(hover?.rect, target); row.steps = row.hovered ? 0 : null;
      if (row.hovered) item = await selection.hit(tab, point).catch(() => null);
    }
    row.picked = Boolean(item) && near(item.rect, target);
    row.crop = row.picked && cropMatches(item);
    row.secretsKept = !item || !(test.secret ?? []).some(secret => `${item.text}\n${item.title}`.includes(secret));
    row.masked = !item || !test.masks ? true : (await Promise.all(test.masks.map(selector => maskedFill(item, test.target.frames, selector)))).every(Boolean);
    row.ok = row.hovered && row.picked && row.crop && row.secretsKept && row.masked;
    if (item?.crop) writeFileSync(join(evidence, `${test.id}.jpg`), Buffer.from(item.crop.split(",")[1], "base64"));
    rows.push(row);
  }
  const areaRows = [];
  if (fresh) for (const test of areas) {
    await load(test.page);
    const from = await pointOf(test.from), to = await pointOf(test.to);
    const rect = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
    const item = await selection.area(tab, rect).catch(error => { console.error(error); return null; });
    const size = item?.crop && nativeImage.createFromDataURL(item.crop).getSize();
    const row = { id: test.id, rect, text: item?.text, contains: item?.contains?.length,
      crop: Boolean(item) && near(item.cropRect, rect, 1) && Math.abs(size.width - rect.width * dpr) <= 2 * dpr && Math.abs(size.height - rect.height * dpr) <= 2 * dpr,
      textOk: Boolean(item) && test.contains.every(text => item.text.includes(text)) && test.excludes.every(text => !item.text.includes(text)),
      withinOk: test.within === undefined || item?.contains?.length === test.within };
    row.masked = !item || !test.masks ? true : (await Promise.all(test.masks.map(selector => maskedFill(item, [], selector)))).every(Boolean);
    row.ok = row.crop && row.textOk && row.withinOk && row.masked;
    if (item?.crop) writeFileSync(join(evidence, `${test.id}.jpg`), Buffer.from(item.crop.split(",")[1], "base64"));
    areaRows.push(row);
  }
  writeFileSync(join(evidence, fresh ? "pick-after.json" : "pick-before.json"), JSON.stringify({ dpr, rows, areaRows }, null, 2));
  for (const row of [...rows, ...areaRows]) console.log(`${row.ok ? "ok  " : "FAIL"} ${row.id.padEnd(20)} ${row.leaf ?? row.defaultLevel ?? ""} steps=${row.steps ?? "-"} ${row.ok ? "" : JSON.stringify({ hovered: row.hovered, picked: row.picked, crop: row.crop, secrets: row.secretsKept, masked: row.masked, textOk: row.textOk, withinOk: row.withinOk, text: row.text, ladder: row.ladder })}`);
  server.close(); win.destroy();
  const failed = [...rows, ...areaRows].filter(row => !row.ok).map(row => row.id);
  if (!reportOnly) assert.deepEqual(failed, [], "every fixture is pickable");
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
