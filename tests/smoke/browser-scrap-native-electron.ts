import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
// test-category: security
/** Pick → Scrap → 서랍 → open, through the real App with CDP input: the scrap opens as exactly its clipped part. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { electronViewInput } from "../support/electron-view-input";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, shellReady } from "../support/browser-shell-acceptance";
import { overlayRead, showPickSidebar } from "../support/browser-pick-acceptance";
import { pages } from "../support/browser-scrap-fixtures.mjs";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE!;
assert.ok(evidence, "Evidence directory required");
mkdirSync(evidence, { recursive: true });
const fontDir = new URL("../../packages/butler-app/client/ui/src/libs/design-system/fonts/ibm-plex-mono/", import.meta.url);
const fonts: Record<string, URL> = {
  "/fonts/regular.woff2": new URL("IBMPlexMono-Regular-Latin1.woff2", fontDir),
  "/fonts/semibold.woff2": new URL("IBMPlexMono-SemiBold-Latin1.woff2", fontDir),
};
const server: ReturnType<typeof Bun.serve> = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
  const path = new URL(request.url).pathname, font = fonts[path];
  if (font) return new Response(Bun.file(font), { headers: { "content-type": "font/woff2" } });
  const page = pages[path.slice(1)];
  const html = typeof page === "function" ? page(`http://localhost:${server.port}`) : page;
  return new Response(html ?? "", { status: html ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } });
} });
const app = await redesignApp(evidence).catch(error => { server.stop(true); throw error; });
const browser = "globalThis.browserAgentSubject";
let tab = "";
const subject = () => `${browser}.tabs.get(${JSON.stringify(tab)})`;
type Point = { x: number; y: number };
async function pagePoint(selector: string): Promise<Point> {
  return app.main<Point>(`(async()=>{const t=${subject()},b=t.view.getBounds(),s=t.bounds.scale??1;
    const r=await t.view.webContents.executeJavaScript(${JSON.stringify(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)});
    return {x:b.x+r.x*s,y:b.y+r.y*s};})()`);
}
const viewInput = electronViewInput(app);
async function input(action: string, from: Point, to?: Point | string) {
  if (action === "key") await app.main(`${browser}.pointer.view.webContents.focus()`);
  await viewInput(action, from, to);
}
const label = () => overlayRead<string | null>(app, "document.querySelector('[data-pick-outline=hover]')?.textContent ?? null");
const scraps = () => app.gateway.api<{ items: Array<{ id: string; title: string; snapshot?: { width: number; height: number } }> }>("/library?kind=scrap");
/** Native click on an App renderer element (content coordinates). */
async function clickApp(expression: string, what: string) {
  await waitBrowser(() => app.page.expression(`Boolean(${expression})`), what);
  const at = await app.page.expression<Point>(`(()=>{const r=(${expression}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await input("click", at);
}
const card = (title: string) => `[...document.querySelectorAll('[data-library-kind=scrap] [data-library-card]')].find(n=>n.textContent.includes(${JSON.stringify(title)}))`;
async function openLibrary(ko: boolean) {
  await showPickSidebar(app);
  await app.click(ko ? "서랍" : "Library");
  await waitBrowser(() => app.page.expression(`Boolean(${card("Webfont card")})`), "Library lists the scrap");
}
/** What the viewer frame holds, read from main (the sandboxed frame runs no script of its own). */
async function viewerFacts() {
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=scrap-frame]'))"), "scrap viewer frame");
  await waitBrowser(() => app.main(`${app.win}.webContents.mainFrame.framesInSubtree.some(f=>f.url==='about:srcdoc')`), "scrap copy loaded");
  const frame = await app.page.expression<{ width: number; height: number; sandbox: string }>("(()=>{const f=document.querySelector('[data-test-class=scrap-frame]'),r=f.getBoundingClientRect();return {width:r.width,height:r.height,sandbox:f.getAttribute('sandbox')}})()");
  // The copy's document, parsed inert in the App page (DOMParser runs nothing).
  const inside = await app.page.expression<{ text: string; scripts: number; handlers: number; csp: string | null; remote: number }>(`(()=>{
    const d=new DOMParser().parseFromString(document.querySelector('[data-test-class=scrap-frame]').srcdoc,'text/html');
    return {text:d.body.textContent.replace(/\\s+/g,' ').trim(),scripts:d.scripts.length,handlers:[...d.querySelectorAll('*')].filter(n=>[...n.attributes].some(a=>/^on/i.test(a.name))).length,
      csp:d.querySelector('meta[http-equiv=Content-Security-Policy]')?.content??null,remote:[...d.querySelectorAll('[src]')].filter(n=>/^https?:/.test(n.getAttribute('src'))).length}})()`);
  // Even main cannot run script in the sandboxed copy.
  const blocked = await app.main<string>(`${app.win}.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc').executeJavaScript('1').then(()=>'ran',e=>String(e))`);
  return { frame, inside, blocked };
}

try {
  await app.page.reload(); await shellReady(app, "en"); await app.click(getAppCopy("en-US").space.general);
  await app.call("open");
  tab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: `${server.url.href}card-font` });
  await app.click("Show browser"); await app.call("activate", { id: tab }); await nativeAligned(app);
  await waitBrowser(() => app.main(`${subject()}.view.webContents.getTitle()==='Webfont card' && ${subject()}.status==='idle'`), "webfont card loaded");
  // A scrap saved before this change: image only, no HTML copy.
  const crop = await app.main<string>(`${subject()}.view.webContents.capturePage({x:24,y:24,width:320,height:120}).then(i=>'data:image/jpeg;base64,'+i.toJPEG(85).toString('base64'))`);
  await app.gateway.api("/library", { method: "POST", body: JSON.stringify({ id: "legacy", kind: "scrap", title: "Legacy scrap", text: "Legacy", url: `${server.url.href}card-font`, site: "127.0.0.1", crop, capturedAt: new Date(Date.now() - 60_000).toISOString() }) });

  // Native input: the shortcut enters picking, the title hovers, ↑ widens to the card, a click picks it.
  await app.main(`${subject()}.view.webContents.sendInputEvent({type:'keyDown',keyCode:'S',modifiers:['meta','shift']})`);
  await waitBrowser(() => app.main(`${subject()}.picking && ${browser}.pointer.ready`), "pick overlay");
  const title = await pagePoint(".title");
  await input("move", title); await waitBrowser(async () => /^h2 · /u.test(await label() ?? ""), "title hovered");
  await input("key", title, "ArrowUp"); await waitBrowser(async () => /^article · /u.test(await label() ?? ""), "↑ widens to the card");
  await input("click", title); await waitBrowser(() => app.main(`${subject()}.selections?.length===1`), "card picked");
  await app.shot("1-card-picked", true);
  // The overlay's Scrap action, clicked natively.
  const scrap = await app.main<Point>(`(async()=>{const v=${browser}.pointer.view,b=v.getBounds();const r=await v.webContents.executeJavaScript(${JSON.stringify(
    "(()=>{const n=[...document.querySelectorAll('[data-slot=selection-bar] button')].find(n=>(n.getAttribute('aria-label')||n.textContent).trim()==='Scrap');const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()")});return {x:b.x+r.x,y:b.y+r.y}})()`);
  await input("click", scrap);
  await waitBrowser(async () => (await scraps()).items.some(item => item.title === "Webfont card" && item.snapshot), "scrap saved with its HTML copy");
  const saved = (await scraps()).items.find(item => item.title === "Webfont card")!;
  const stored = await app.gateway.api<{ html: string }>(`/library/${saved.id}/snapshot`);
  assert.ok(stored.html.startsWith("<!doctype html>") && stored.html.length < 5 * 1024 * 1024);
  const picked = await app.main<{ width: number; height: number }>(`${subject()}.view.webContents.executeJavaScript("document.querySelector('#card').getBoundingClientRect().toJSON()")`);
  assert.ok(Math.abs(saved.snapshot!.width - picked.width) <= 1 && Math.abs(saved.snapshot!.height - picked.height) <= 1, "copy sized like the card");
  await input("key", title, "Escape"); await waitBrowser(() => app.main(`!${subject()}.picking`), "Escape ends picking");

  // Before (kept for scraps without a copy): its detail shows the crop, and its source action loads the whole page.
  await openLibrary(false);
  await app.shot("2-library", false);
  await clickApp(card("Legacy scrap"), "legacy scrap card");
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=library-detail] img[alt=\"Legacy scrap\"]')) && !document.querySelector('[data-test-class=scrap-frame]')"), "legacy scrap detail shows its crop");
  await app.click("Open source page");
  await waitBrowser(async () => (await app.call<{ tabs: Array<{ url: string }> }>("state")).tabs.filter(t => t.url.endsWith("/card-font")).length >= 2, "legacy scrap opens the source page");
  await nativeAligned(app); await app.shot("3-before-legacy-opens-page", true);

  const results: unknown[] = [];
  for (const [language, theme] of [["en", "light"], ["en", "dark"], ["ko", "light"], ["ko", "dark"]] as const) {
    await app.settings(language, theme, 1440);
    await openLibrary(language === "ko");
    await clickApp(card("Webfont card"), "scrap card");
    const facts = await viewerFacts();
    assert.ok(Math.abs(facts.frame.width - saved.snapshot!.width) <= 1 && Math.abs(facts.frame.height - saved.snapshot!.height) <= 1, `frame sized like the card: ${JSON.stringify(facts.frame)}`);
    assert.ok(!facts.frame.sandbox.includes("allow-scripts") && !facts.frame.sandbox.includes("allow-same-origin"));
    assert.equal(facts.inside.scripts, 0); assert.equal(facts.inside.handlers, 0); assert.equal(facts.inside.remote, 0);
    assert.match(facts.inside.csp ?? "", /default-src 'none'/u);
    assert.notEqual(facts.blocked, "ran", "no script runs in the viewer frame");
    assert.match(facts.inside.text, /Webfont card[\s\S]*Variables, nested selectors and a pseudo badge\./u);
    await app.shot(`4-after-${language}-${theme}-scrap-open`);
    results.push({ language, theme, ...facts });
    if (language === "en" && theme === "light") {
      // The small source action opens the scrap's page.
      const before = (await app.call<{ tabs: unknown[] }>("state")).tabs.length;
      await app.click("Open source page");
      await waitBrowser(async () => (await app.call<{ tabs: unknown[] }>("state")).tabs.length === before + 1, "source page opened");
    } else await app.page.press("Escape");
  }
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, snapshot: saved.snapshot, bytes: stored.html.length, results }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), main: app.lastMain(), label: await label().catch(() => null), state: await app.call("state").catch(() => null) }, null, 2));
  await app.shot("failure", true).catch(() => {}); throw error;
} finally { server.stop(true); await app.stop(); }
