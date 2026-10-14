// Scrap snapshots in real Electron: pick → self-contained HTML copy → reopen offline in the sandboxed viewer frame →
// pixel diff against the pick's crop. Proves no script runs, nothing loads from the network and filled fields stay masked.
// Run: BUTLER_DATA=$(mktemp -d) HOME=$(mktemp -d) BUTLER_BROWSER_EVIDENCE=<dir> <electron 44> tests/smoke/browser-scrap-snapshot-electron.mjs
import { app, BrowserWindow, WebContentsView, nativeImage, screen, session } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cases, pages } from "../support/browser-scrap-fixtures.mjs";
import { attachNativeWorlds } from "../../packages/butler-app/client/electron/browser/native-worlds.mjs";
import { BrowserSelection } from "../../packages/butler-app/client/electron/browser/selection.mjs";

const browserDir = new URL("../../packages/butler-app/client/electron/browser/", import.meta.url);
const fontDir = new URL("../../packages/butler-app/client/ui/src/libs/design-system/fonts/ibm-plex-mono/", import.meta.url);
// Pass: at most this share of crop pixels differs by more than DIFF_LEVEL in any channel (JPEG crops, text antialiasing).
const MISMATCH_MAX = Number(process.env.BUTLER_SCRAP_MISMATCH_MAX ?? 0.03), DIFF_LEVEL = 64;
app.setPath("userData", process.env.BUTLER_DATA);
app.commandLine.appendSwitch("host-resolver-rules", "MAP cross.test 127.0.0.1");
app.on("window-all-closed", () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const near = (a, b, tolerance = 2) => a && b && ["x", "y", "width", "height"].every(key => Math.abs(a[key] - b[key]) <= tolerance);

function png(width, height, paint) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(paint(x, y), (y * width + x) * 4);
  return nativeImage.createFromBitmap(pixels, { width, height }).toPNG();
}
const files = {
  "/img/photo.png": ["image/png", png(192, 144, (x, y) => [(x * 3) % 255, (y * 2) % 255, 160, 255])],
  "/img/small.png": ["image/png", png(96, 72, (x, y) => [40, (x + y) % 255, 200, 255])],
  "/img/tile.png": ["image/png", png(40, 40, (x, y) => ((x < 20) === (y < 20) ? [240, 220, 250, 255] : [200, 190, 245, 255]))],
  "/img/icon.svg": ["image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="72"><rect width="96" height="72" fill="#20bf6b"/><circle cx="48" cy="36" r="22" fill="white"/></svg>')],
  "/fonts/regular.woff2": ["font/woff2", readFileSync(new URL("IBMPlexMono-Regular-Latin1.woff2", fontDir))],
  "/fonts/semibold.woff2": ["font/woff2", readFileSync(new URL("IBMPlexMono-SemiBold-Latin1.woff2", fontDir))],
};

app.whenReady().then(async () => {
  const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence, "BUTLER_BROWSER_EVIDENCE required");
  mkdirSync(evidence, { recursive: true });
  let served = 0;
  const server = createServer((request, response) => {
    served++;
    const path = request.url.split("?")[0], other = `http://cross.test:${server.address().port}`;
    const file = files[path], name = path.slice(1), html = typeof pages[name] === "function" ? pages[name](other) : pages[name];
    if (file) { response.writeHead(200, { "content-type": file[0], "access-control-allow-origin": "*", "cache-control": "max-age=600" }); response.end(file[1]); return; }
    response.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" }); response.end(html ?? "");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({ width: 1000, height: 700, useContentSize: true, show: false, webPreferences: { sandbox: true } });
  const view = new WebContentsView({ webPreferences: { preload: fileURLToPath(new URL("page-controls.cjs", browserDir)),
    nodeIntegrationInSubFrames: true, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  win.setAlwaysOnTop(true, "floating"); win.showInactive();
  const tab = { id: "scrap", view, epoch: 1, bounds: { scale: 1 }, selections: [], owner: "mine", picking: true };
  attachNativeWorlds(tab);
  const browser = { tabs: new Map([[tab.id, tab]]), activeId: tab.id, publish() {}, sync() {}, getWindow: () => win,
    pointer: { acceptInput: () => true, sync() {}, inputFailed() {}, view: null } };
  const selection = new BrowserSelection(browser);
  const contents = view.webContents, dpr = screen.getPrimaryDisplay().scaleFactor;

  async function load(name) {
    tab.url = `${origin}/${name}`; tab.epoch++; tab.selections = []; tab.pickHover = null; selection.preferred = null;
    await contents.loadURL(tab.url);
    for (let i = 0; i < 100; i++) {
      const ready = await contents.executeJavaScript("window.__ready === true && document.readyState === 'complete'");
      const live = [...tab.nativeFrames.values()].filter(frame => !frame.isDestroyed() && !frame.detached).length;
      if (ready && live >= (name === "frames" ? 2 : 1)) break;
      await wait(50);
    }
    for (let i = 0; i < 40; i++) { const probe = await contents.capturePage({ x: 0, y: 0, width: 4, height: 4 }).catch(() => null); if (probe && !probe.isEmpty()) break; await wait(50); }
    await wait(150);
  }
  async function rectOf(frames = [], el) {
    let frame = contents.mainFrame, x = 0, y = 0;
    for (const name of frames) {
      const box = await frame.executeJavaScript(`(()=>{const f=document.querySelector('iframe[name="${name}"]'),r=f.getBoundingClientRect(),s=getComputedStyle(f);
        return {x:r.x+f.clientLeft+parseFloat(s.paddingLeft),y:r.y+f.clientTop+parseFloat(s.paddingTop)}})()`);
      x += box.x; y += box.y; frame = frame.frames.find(child => child.name === name);
    }
    const r = await frame.executeJavaScript(`(()=>{const r=(${el}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
    return { ...r, x: r.x + x, y: r.y + y };
  }
  /** A pick of exactly the fixture's element: hover its center, walk the ladder to its box, press. */
  async function pick(test) {
    const target = await rectOf(test.frames, test.el), point = { x: Math.round(target.x + target.width / 2), y: Math.round(target.y + Math.min(target.height / 2, 30)) };
    await selection.hoverAt(tab, point);
    const levels = tab.pickHover?.levels ?? [], found = levels.findIndex(level => near(level.rect, target));
    assert.ok(found >= 0, `${test.id}: target level in ${levels.map(level => level.name)}`);
    for (let i = 0; i < Math.abs(found - tab.pickHover.index); i++) selection.step(tab, Math.sign(found - tab.pickHover.index));
    const item = await selection.hit(tab, point);
    assert.ok(item, `${test.id}: picked`);
    tab.selections = [...tab.selections, item];
    return item;
  }
  async function areaPick(test) {
    const from = await rectOf([], test.area.from), to = await rectOf([], test.area.to), [dl, dt, dr, db] = test.area.inset;
    const rect = { x: from.x + dl, y: from.y + dt, width: to.x + to.width + dr - from.x - dl, height: to.y + to.height + db - from.y - dt };
    return selection.area(tab, rect);
  }

  const shots = [];
  for (const test of cases) {
    await load(test.page);
    const item = test.area ? await areaPick(test) : await pick(test);
    const masks = [];
    for (const mask of test.masks ?? []) masks.push(await rectOf(mask.frames, mask.el));
    const started = performance.now();
    const snap = await selection.snapshot(tab.id, item.id);
    const elapsed = Math.round(performance.now() - started);
    assert.ok(snap, `${test.id}: snapshot`);
    writeFileSync(join(evidence, `${test.id}.html`), snap.html);
    writeFileSync(join(evidence, `${test.id}-crop.jpg`), Buffer.from(item.crop.split(",")[1], "base64"));
    shots.push({ test, item, snap, masks, elapsed });
  }
  // Offline from here: the fixture server stops and the viewer session has no network at all.
  await new Promise(resolve => server.close(resolve));
  const servedBefore = served;
  const viewerSession = session.fromPartition("scrap-viewer-offline");
  const requests = [];
  viewerSession.webRequest.onBeforeRequest((detail, done) => {
    const allowed = /^(data|about|blob):/u.test(detail.url);
    if (!allowed) requests.push(detail.url);
    done({ cancel: !allowed });
  });
  const viewer = new BrowserWindow({ width: 1000, height: 760, useContentSize: true, show: false, webPreferences: { session: viewerSession, sandbox: true, contextIsolation: true } });
  viewer.webContents.session.enableNetworkEmulation({ offline: true });
  viewer.setAlwaysOnTop(true, "floating"); viewer.showInactive();
  await viewer.loadURL("about:blank");
  const consoles = [];
  viewer.webContents.on("console-message", event => consoles.push(event.message));
  await viewer.webContents.executeJavaScript("document.body.style.margin='0';document.body.style.background='#fff';window.messages=0;addEventListener('message',()=>window.messages++);true");

  const rows = [];
  for (const { test, item, snap, masks, elapsed } of shots) {
    // The App viewer's frame: sandboxed without scripts or same-origin, links leave as popups.
    await viewer.webContents.executeJavaScript(`new Promise(resolve=>{document.body.replaceChildren();const f=document.createElement('iframe');
      f.setAttribute('sandbox','allow-popups allow-popups-to-escape-sandbox');f.style.cssText='border:0;display:block;width:${snap.width}px;height:${snap.height}px';
      f.onload=()=>resolve(true);f.srcdoc=${JSON.stringify(snap.html)};document.body.append(f)})`);
    await wait(400);
    const shot = await viewer.webContents.capturePage({ x: 0, y: 0, width: Math.ceil(snap.width), height: Math.ceil(snap.height) });
    writeFileSync(join(evidence, `${test.id}-snapshot.png`), shot.toPNG());
    const crop = nativeImage.createFromDataURL(item.crop), cs = crop.getSize(), cb = crop.toBitmap();
    const ss = shot.getSize(), sb = shot.toBitmap(), sx = ss.width / snap.width;
    // A crop starts at the whole CSS pixel at or before its rect (capturePage rounds outward).
    const ox = Math.round((Math.floor(item.cropRect.x) - snap.x) * sx), oy = Math.round((Math.floor(item.cropRect.y) - snap.y) * sx);
    let compared = 0, mismatched = 0, total = 0;
    for (let y = 0; y < cs.height; y++) for (let x = 0; x < cs.width; x++) {
      const tx = x + ox, ty = y + oy;
      if (tx < 0 || ty < 0 || tx >= ss.width || ty >= ss.height) {
        // The crop's outward rounding (under one CSS pixel) is not part of the element.
        if (tx < -sx || ty < -sx || tx >= ss.width + sx || ty >= ss.height + sx) { compared++; mismatched++; }
        continue;
      }
      const a = (y * cs.width + x) * 4, b = (ty * ss.width + tx) * 4;
      const d = Math.max(Math.abs(cb[a] - sb[b]), Math.abs(cb[a + 1] - sb[b + 1]), Math.abs(cb[a + 2] - sb[b + 2]));
      compared++; total += d; if (d > DIFF_LEVEL) mismatched++;
    }
    const maskedOk = masks.every(mask => [[0.2, 0.5], [0.5, 0.5], [0.8, 0.5]].every(([fx, fy]) => {
      const x = Math.floor((mask.x + mask.width * fx - snap.x) * sx), y = Math.floor((mask.y + mask.height * fy - snap.y) * sx);
      if (x < 0 || y < 0 || x >= ss.width || y >= ss.height) return true;
      const o = (y * ss.width + x) * 4; return [sb[o], sb[o + 1], sb[o + 2]].every(v => Math.abs(v - 0xd9) <= 6);
    }));
    const html = snap.html;
    const scriptFree = !/<script|\son[a-z]+\s*=|javascript:|\saction=|\ssrcdoc=/iu.test(html) && html.includes("Content-Security-Policy");
    const remoteFree = !/(src|srcset)="https?:|url\("?https?:|@import/iu.test(html);
    const secretsKept = !(test.secret ?? []).some(secret => html.includes(secret));
    const mismatch = mismatched / Math.max(1, compared);
    const row = { id: test.id, bytes: html.length, ms: elapsed, size: `${Math.round(snap.width)}x${Math.round(snap.height)}`, crop: `${cs.width}x${cs.height}`,
      mismatch: Number((mismatch * 100).toFixed(2)), meanDiff: Number((total / Math.max(1, compared)).toFixed(2)), maskedOk, scriptFree, remoteFree, secretsKept };
    row.ok = mismatch <= MISMATCH_MAX && maskedOk && scriptFree && remoteFree && secretsKept;
    rows.push(row);
  }
  const ran = await viewer.webContents.executeJavaScript("window.messages");
  const summary = { dpr, served: servedBefore, offlineRequests: requests, viewerMessages: ran, consoles, rows };
  writeFileSync(join(evidence, "scrap-snapshots.json"), JSON.stringify(summary, null, 2));
  console.log("id                 bytes     ms   size      mismatch%  meanDiff  masked script remote secrets");
  for (const row of rows) console.log(`${row.ok ? "ok  " : "FAIL"} ${row.id.padEnd(14)} ${String(row.bytes).padStart(8)} ${String(row.ms).padStart(5)}  ${row.size.padEnd(9)} ${String(row.mismatch).padStart(8)}  ${String(row.meanDiff).padStart(8)}  ${row.maskedOk} ${row.scriptFree} ${row.remoteFree} ${row.secretsKept}`);
  console.log(`offline requests=${requests.length} viewer messages=${ran}`);
  win.destroy(); viewer.destroy();
  if (process.env.BUTLER_SCRAP_REPORT_ONLY !== "1") {
    assert.deepEqual(requests, [], "the viewer loads nothing from the network");
    assert.equal(ran, 0, "no script ran in the viewer");
    assert.deepEqual(rows.filter(row => !row.ok).map(row => row.id), [], "every snapshot matches its crop");
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
