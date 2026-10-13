// An answer card saved to 서랍 in real Electron: the built App UI renders a card, the App-part snapshot (the page
// scrap pipeline) copies it, and the copy reopens offline in the 서랍 viewer's sandboxed frame and matches the card's
// own pixels. Proves the copy is self-contained (its picture inlined, nothing remote, no script).
// Run: BUTLER_DATA=$(mktemp -d) HOME=$(mktemp -d) BUTLER_APP_PART_EVIDENCE=<dir> <electron 44> tests/smoke/app-part-snapshot-electron.mjs
// Needs a fresh UI build (npm --prefix packages/butler-app/client/ui run build).
import { app, BrowserWindow, nativeImage, session } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotApp } from "../../packages/butler-app/client/electron/browser/app-snapshot.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dist = join(root, "packages/butler-app/client/ui/dist");
const photo = readFileSync(join(root, "packages/butler-app/client/ui/src/libs/design-system/blocks/Wallpaper/modules/butler.photo-daisies/photo.jpg"));
// Pass: at most this share of the card's pixels differs by more than DIFF_LEVEL in any channel (JPEG crop, antialiasing).
const MISMATCH_MAX = 0.03, DIFF_LEVEL = 64;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
app.setPath("userData", process.env.BUTLER_DATA);
app.on("window-all-closed", () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const card = { title: "Gooseneck pour-over kettle", sub: "Kitchen · 1.0 L", label: "Best value", key: "kettle",
  value: { amount: 39, cur: "USD", was: 59 }, facts: ["Ships in 2 days", "Matte black"], text: "Pours a steady thin stream for even extraction.",
  source: "https://shop.example.com/kettle", checked: "2026-10-13T08:41:00Z", img: "img_kettle0001" };
const fixture = { background: "plain", messages: [{ id: "answer", chat_id: "butler-client", role: "assistant", status: "delivered", text: "One pick.",
  created_at: "2026-10-13T08:51:00Z", answer_blocks: [{ call_id: "blocks", set_ids: [], spec: { v: 1, blocks: [{ type: "cards", media: "1:1",
    items: [{ ...card, image_url: `/message-assets/${card.img}?expires=4102444800&signature=smoke` }] }] } }] }] };
const api = { "/navigation": {}, "/session-view": {}, "/summary": {}, "/events/live": {}, "/health": {}, "/session-queue": { queued_messages: [] } };

app.whenReady().then(async () => {
  const evidence = process.env.BUTLER_APP_PART_EVIDENCE; assert.ok(evidence, "BUTLER_APP_PART_EVIDENCE required");
  assert.ok(existsSync(join(dist, "index.html")), "built UI required");
  mkdirSync(evidence, { recursive: true });
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url.split("?")[0]);
    const json = data => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, data })); };
    if (path in api) return json(api[path]);
    if (/^\/sessions\/[^/]+\/controls$/u.test(path)) return json({ session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1",
      controls: { model: "openai/gpt-5.6-sol", reasoning_effort: "none", access_mode: "full_access", plan_mode: false } });
    if (path.startsWith("/message-assets/")) { response.writeHead(200, { "content-type": "image/jpeg" }); response.end(photo); return; }
    if (path === "/" || path === "/index.html") {
      const html = readFileSync(join(dist, "index.html"), "utf8").replace("<head>", `<head><script>window.butlerConversationFixture=${JSON.stringify(fixture).replaceAll("<", "\\u003c")}</script>`);
      response.writeHead(200, { "content-type": TYPES[".html"] }); response.end(html); return;
    }
    const file = normalize(join(dist, path));
    if (!file.startsWith(dist) || !existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }); response.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({ width: 1100, height: 900, useContentSize: true, show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  win.setAlwaysOnTop(true, "floating"); win.showInactive();
  await win.loadURL(`${origin}/?visual=components&theme=light&locale=ko`);
  const contents = win.webContents;
  for (let i = 0; i < 200; i++) {
    if (await contents.executeJavaScript("document.querySelector('[data-slot=item-card] [data-slot=media-frame]')?.getAttribute('data-fit')==='cover'")) break;
    await wait(50);
  }
  await contents.executeJavaScript("document.fonts.ready.then(()=>true)");
  await wait(300);
  const target = "card-0001-smoke";
  await contents.executeJavaScript(`document.querySelector('[data-slot=item-card]').setAttribute('data-butler-snapshot',${JSON.stringify(target)})`);
  const started = performance.now();
  const copy = await snapshotApp(win, target);
  const elapsed = Math.round(performance.now() - started);
  assert.ok(copy, "the card has a copy");
  assert.ok(copy.crop?.startsWith("data:image/jpeg;base64,"), "the card's own pixels are the scrap's fallback picture");
  const html = copy.html;
  writeFileSync(join(evidence, "card-snapshot.html"), html);
  writeFileSync(join(evidence, "card-crop.jpg"), Buffer.from(copy.crop.split(",")[1], "base64"));
  const facts = {
    scriptFree: !/<script|\son[a-z]+\s*=|javascript:|\saction=|\ssrcdoc=/iu.test(html) && html.includes("Content-Security-Policy"),
    remoteFree: !/(src|srcset)="(https?:|app:)|url\("?(https?:|app:)|@import/iu.test(html),
    pictureInlined: /src="data:image\/jpeg;base64,/u.test(html),
    textKept: [card.title, ...card.facts].every(text => html.includes(text)),
    markerGone: !html.includes(target),
  };

  // The 서랍 viewer: an offline session, the copy in a frame sandboxed without scripts or same-origin.
  await new Promise(resolve => server.close(resolve));
  const viewerSession = session.fromPartition("app-part-viewer-offline");
  const requests = [];
  viewerSession.webRequest.onBeforeRequest((detail, done) => {
    const allowed = /^(data|about|blob):/u.test(detail.url);
    if (!allowed) requests.push(detail.url);
    done({ cancel: !allowed });
  });
  const viewer = new BrowserWindow({ width: 1100, height: 900, useContentSize: true, show: false, webPreferences: { session: viewerSession, sandbox: true, contextIsolation: true } });
  viewer.webContents.session.enableNetworkEmulation({ offline: true });
  viewer.setAlwaysOnTop(true, "floating"); viewer.showInactive();
  await viewer.loadURL("about:blank");
  await viewer.webContents.executeJavaScript(`new Promise(resolve=>{document.body.style.margin='0';document.body.style.background='#fff';window.messages=0;addEventListener('message',()=>window.messages++);
    const f=document.createElement('iframe');f.setAttribute('sandbox','allow-popups allow-popups-to-escape-sandbox');
    f.style.cssText='border:0;display:block;width:${copy.width}px;height:${copy.height}px';f.onload=()=>resolve(true);f.srcdoc=${JSON.stringify(html)};document.body.append(f)})`);
  await wait(500);
  const shot = await viewer.webContents.capturePage({ x: 0, y: 0, width: Math.ceil(copy.width), height: Math.ceil(copy.height) });
  writeFileSync(join(evidence, "card-snapshot-viewer.png"), shot.toPNG());
  const crop = nativeImage.createFromDataURL(copy.crop), cs = crop.getSize(), cb = crop.toBitmap();
  const ss = shot.getSize(), sb = shot.toBitmap();
  let compared = 0, mismatched = 0;
  for (let y = 0; y < Math.min(cs.height, ss.height); y++) for (let x = 0; x < Math.min(cs.width, ss.width); x++) {
    const a = (y * cs.width + x) * 4, b = (y * ss.width + x) * 4;
    const d = Math.max(Math.abs(cb[a] - sb[b]), Math.abs(cb[a + 1] - sb[b + 1]), Math.abs(cb[a + 2] - sb[b + 2]));
    compared++; if (d > DIFF_LEVEL) mismatched++;
  }
  const ran = await viewer.webContents.executeJavaScript("window.messages");
  const mismatch = mismatched / Math.max(1, compared);
  const summary = { bytes: html.length, ms: elapsed, size: `${Math.round(copy.width)}x${Math.round(copy.height)}`, crop: `${cs.width}x${cs.height}`,
    shot: `${ss.width}x${ss.height}`, mismatchPercent: Number((mismatch * 100).toFixed(2)), offlineRequests: requests, viewerMessages: ran, ...facts };
  // The 서랍 item the App saves for this card (the shape saveAnswerItem posts).
  writeFileSync(join(evidence, "card-scrap.json"), JSON.stringify({ id: "answer-card-smoke", kind: "scrap", title: card.title, url: card.source,
    site: "shop.example.com", crop: copy.crop, capturedAt: "2026-10-13T08:51:00.000Z", text: "$39.00 · Ships in 2 days · Matte black",
    snapshot: { html, width: copy.width, height: copy.height },
    fields: { title: card.title, sub: card.sub, label: card.label, value: card.value, facts: card.facts, text: card.text, source: card.source, checked: card.checked } }));
  writeFileSync(join(evidence, "card-snapshot.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  win.destroy(); viewer.destroy();
  assert.deepEqual(requests, [], "the viewer loads nothing from the network");
  assert.equal(ran, 0, "no script ran in the viewer");
  assert.ok(Object.values(facts).every(Boolean), `copy facts: ${JSON.stringify(facts)}`);
  assert.ok(mismatch <= MISMATCH_MAX, `the copy matches the card (${(mismatch * 100).toFixed(2)}% differs)`);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
