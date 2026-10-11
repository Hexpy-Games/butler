// test-category: security
/** Pick granularity, whole modals, cross-site frames and areas through the real App overlay with native OS input. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, shellReady } from "../support/browser-shell-acceptance";
import { overlayRead } from "../support/browser-pick-acceptance";
import { pages } from "../support/browser-pick-fixtures.mjs";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE!;
const driver = process.env.BUTLER_NATIVE_MOUSE_EXECUTABLE!;
assert.ok(evidence && driver, "Evidence and native mouse driver required");
mkdirSync(evidence, { recursive: true });
const server: ReturnType<typeof Bun.serve> = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
  const page = pages[new URL(request.url).pathname.slice(1)];
  // localhost and 127.0.0.1 are different sites: the framed card is a cross-site (out-of-process) frame.
  const html: string | undefined = typeof page === "function" ? page(`http://localhost:${server.port}`) : page;
  return new Response(html ?? "", { status: html ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } });
} });
const app = await redesignApp(evidence).catch(error => { server.stop(true); throw error; });
const browser = "globalThis.browserAgentSubject";
let tab = "";
const subject = () => `${browser}.tabs.get(${JSON.stringify(tab)})`;
type Point = { x: number; y: number };
/** Screen point (App content coordinates) of a page element, optionally inside a named iframe. */
async function point(selector: string, frame?: string, fx = 0.5, fy = 0.5): Promise<Point> {
  return app.main<Point>(`(async()=>{const t=${subject()},c=t.view.webContents,b=t.view.getBounds(),s=t.bounds.scale??1;
    const rect=code=>\`(()=>{const r=(\${code}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()\`;
    let o={x:0,y:0},f=c.mainFrame;
    ${frame ? `const box=await c.executeJavaScript(\`(()=>{const f=document.querySelector('iframe[name="${frame}"]'),r=f.getBoundingClientRect();return {x:r.x+f.clientLeft,y:r.y+f.clientTop}})()\`);o=box;f=c.mainFrame.frames.find(n=>n.name===${JSON.stringify(frame)});` : ""}
    const r=await f.executeJavaScript(rect(${JSON.stringify(`document.querySelector(${JSON.stringify(selector)})`)}));
    return {x:b.x+(o.x+r.x+r.width*${fx})*s,y:b.y+(o.y+r.y+r.height*${fy})*s};})()`);
}
async function input(action: string, from: Point, to?: Point | number) {
  const facts = await app.main<{ pid: number; x: number; y: number }>(`(()=>{${app.win}.show();${app.win}.focus();${app.win}.moveTop();const r=${app.win}.getContentBounds();return {pid:process.pid,x:r.x,y:r.y}})()`);
  // Raising the window focuses the App renderer; pick mode keeps keys in the overlay it focused on entry.
  if (action === "key") await app.main(`${browser}.pointer.view.webContents.focus()`);
  const args = [driver, String(facts.pid), action, String(facts.x + from.x), String(facts.y + from.y)];
  if (typeof to === "number") args.push(String(to));
  else if (to) args.push(String(facts.x + to.x), String(facts.y + to.y));
  const result = Bun.spawnSync(args);
  assert.equal(result.exitCode, 0, result.stderr.toString());
}
const label = () => overlayRead<string | null>(app, "document.querySelector('[data-pick-outline=hover]')?.textContent ?? null");
async function hovered(pattern: RegExp, what: string) {
  await waitBrowser(async () => pattern.test(await label() ?? ""), what);
}
async function picks(count: number) { await waitBrowser(() => app.main(`${subject()}.selections?.length===${count}`), `${count} picks`); }
async function loadPage(name: string, title: string) {
  await app.main(`${subject()}.view.webContents.loadURL(${JSON.stringify(`${server.url.href}${name}`)})`);
  await waitBrowser(() => app.main(`${subject()}.view.webContents.getTitle()===${JSON.stringify(title)} && ${subject()}.status==='idle'`), `${name} loaded`);
}
/** The crop is the picked box at device pixels, and filled fields are flat masks. */
async function cropFits(index: number) {
  return app.main<{ ok: boolean; size: { width: number; height: number }; css: { width: number; height: number } }>(`(()=>{
    const electron=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})('electron');
    const t=${subject()},p=t.selections[${index}],size=electron.nativeImage.createFromDataURL(p.crop).getSize(),s=(t.bounds.scale??1)*electron.screen.getDisplayMatching(${app.win}.getBounds()).scaleFactor;
    return {ok:Math.abs(size.width-p.cropRect.width*s)<=2*s+1&&Math.abs(size.height-p.cropRect.height*s)<=2*s+1,size,css:{width:p.cropRect.width,height:p.cropRect.height}};})()`);
}
try {
  await app.page.reload(); await shellReady(app, "en"); await app.click("General");
  await app.call("open");
  tab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: `${server.url.href}modal` });
  await app.click("Show browser"); await app.call("activate", { id: tab }); await nativeAligned(app);
  await waitBrowser(() => app.main(`${subject()}.view.webContents.getTitle()==='Role dialog'`), "modal fixture loaded");
  await app.main(`${subject()}.view.webContents.sendInputEvent({type:'keyDown',keyCode:'S',modifiers:['meta','shift']})`);
  await waitBrowser(() => app.main(`${subject()}.picking && ${browser}.pointer.ready`), "shortcut pick overlay");
  // Evidence: every overlay mouse input and the hover tag it produced.
  await app.main(`(()=>{const p=${browser}.pointer,mouse=p.mouse.bind(p);globalThis.pickTrace=[];
    const s=${browser}.selection,probe=s.probe.bind(s);s.probe=(...a)=>probe(...a).then(l=>{if(!l.levels.length)pickTrace.push({empty:a[1]});return l},e=>{pickTrace.push({probeError:String(e?.stack??e),at:a[1]});throw e});
    p.mouse=raw=>{const r=mouse(raw);setTimeout(()=>pickTrace.push({type:raw.type,x:raw.x,y:raw.y,modifiers:raw.modifiers,label:${subject()}.pickHover?.label??null}),60);return r};})()`);
  const steps: unknown[] = [];

  // A paragraph inside the modal is the default; ↑ (real key) widens to the whole dialog; a click picks it.
  const text = await point("#dlg-text");
  await input("move", text); await hovered(/^p · \d+ × \d+ · ↑$/u, "paragraph is the default level");
  steps.push({ hover: await label() }); await app.shot("1-hover-paragraph", true);
  await input("key", text, 126); await hovered(/^dialog · \d+ × \d+ · ↑↓$/u, "↑ widens to the dialog");
  steps.push({ up: await label() }); await app.shot("2-up-dialog", true);
  await input("click", text); await picks(1);
  const dialog = await app.main<{ title: string; text: string; rect: Point & { width: number } }>(`${subject()}.selections[0]`);
  assert.equal(dialog.title, "Subscribe");
  assert.ok(!dialog.text.includes("me@example.com") && !dialog.text.includes("hunter2"), "field values never reach text");
  const want = await app.main<{ width: number }>(`${subject()}.view.webContents.executeJavaScript("document.querySelector('#dlg').getBoundingClientRect().toJSON()")`);
  assert.ok(Math.abs(dialog.rect.width - want.width) <= 1, "pick is the whole dialog");
  const dialogCrop = await cropFits(0); assert.ok(dialogCrop.ok, JSON.stringify(dialogCrop));
  await app.shot("3-dialog-picked", true);
  // The dimmed backdrop stands for the modal: one click there toggles the same dialog pick.
  const backdrop = await point("main h1", undefined, 0.02, 0.5);
  await input("move", backdrop); await hovered(/^dialog · /u, "backdrop hovers the dialog");
  await input("click", backdrop); await picks(0);
  await input("click", backdrop); await picks(1);
  steps.push({ backdrop: "toggled dialog" });

  // Cross-site iframe: the framed heading, ↑ to its card, click; the filled field is masked.
  // A new document clears the picks of the old one (no stale outlines over the new page).
  await loadPage("mix", "Pick mix"); await picks(0); await app.shot("4a-navigated-clear", true);
  const framed = await point("#fh", "cross");
  await input("move", framed); await hovered(/^h3 · /u, "framed heading hovered across sites");
  await input("key", framed, 126); await hovered(/^div · \d+ × \d+ · ↑↓$/u, "↑ widens to the framed card");
  await app.shot("4-frame-card", true);
  await input("click", framed); await picks(1);
  const card = await app.main<{ text: string; title: string }>(`${subject()}.selections[0]`);
  assert.equal(card.title, "Framed card"); assert.ok(!card.text.includes("framed secret"));
  assert.ok((await cropFits(0)).ok, "framed card crop");

  // ⌥-drag draws an area over part of a paragraph: the crop is the rectangle and its text the covered run.
  const from = await point("#strong", undefined, 0, 0.5), to = await point("#link", undefined, 1, 0.5);
  await input("altdrag", { x: from.x - 2, y: from.y - 10 }, { x: to.x + 2, y: to.y + 10 }); await picks(2);
  const area = await app.main<{ tag: string; text: string }>(`${subject()}.selections[1]`);
  assert.equal(area.tag, "area"); assert.equal(area.text, "bold words sit beside a link");
  assert.ok((await cropFits(1)).ok, "area crop");
  await app.shot("5-two-picks", true);

  // A plain drag from a kept pick still carries every pick into the composer.
  await input("drag", await point("#strong"), { ...await app.page.expression<Point>("(()=>{const r=document.querySelector('[data-test-class=\"composer-card\"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()") });
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-slot=element-chip]').length===2"), "two chips in the composer");
  await app.shot("6-composer-chips");
  await input("key", framed, 53);
  await waitBrowser(() => app.main(`!${subject()}.picking`), "Escape ends picking");
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, steps, dialogCrop, picks: await app.main(`${subject()}.selections.map(({crop,...p})=>p)`) }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), main: app.lastMain(), label: await label().catch(() => null), trace: await app.main("globalThis.pickTrace").catch(() => null),
    state: await app.call("state").catch(() => null) }, null, 2));
  await app.shot("failure", true).catch(() => {}); throw error;
} finally { server.stop(true); await app.stop(); }
