// test-category: security
/** Native OS input through the real App overlay; no CDP mouse injection. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, shellReady } from "../support/browser-shell-acceptance";
import { showPickSidebar } from "../support/browser-pick-acceptance";
import { pointerPage } from "../support/browser-pointer-page";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE!;
const driver = process.env.BUTLER_NATIVE_MOUSE_EXECUTABLE!;
assert.ok(evidence && driver, "Evidence and native mouse driver required");
mkdirSync(evidence, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(pointerPage, { headers: { "content-type": "text/html" } }) });
const app = await redesignApp(evidence).catch(error => { server.stop(true); throw error; });
const started = Date.now();
let tab = "";
const browser = "globalThis.browserAgentSubject";
const subject = () => `${browser}.tabs.get(${JSON.stringify(tab)})`;
const page = <T>(code: string) => app.main<T>(`${subject()}.view.webContents.executeJavaScript(${JSON.stringify(code)})`);
type Point = { x: number; y: number; selector?: string; where?: number; renderer?: boolean };
async function point(selector: string, where = 0.5): Promise<Point> {
  const p = await page<Point>(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width*${where},y:r.y+r.height/2}})()`);
  const at = await app.main<Point>(`(()=>{const t=${subject()},b=t.view.getBounds(),s=t.bounds.scale??1;return {x:b.x+${p.x}*s,y:b.y+${p.y}*s}})()`);
  return { ...at, selector, where };
}
const rendererPoint = async (selector: string): Promise<Point> => ({ ...await app.page.expression<Point>(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`), selector, renderer: true });
async function input(action: string, from: Point, to?: Point) {
  const facts = await app.main<{ pid: number; x: number; y: number }>(`(()=>{${app.win}.show();${app.win}.focus();${app.win}.moveTop();const r=${app.win}.getContentBounds();return {pid:process.pid,x:r.x,y:r.y}})()`);
  // Let the real pointer dismiss renderer tooltips and settle native occlusion
  // before pressing. Unlike old smokes, the held gesture never changes targets.
  const moved = Bun.spawnSync([driver, String(facts.pid), "move", String(facts.x + from.x), String(facts.y + from.y)]);
  assert.equal(moved.exitCode, 0, moved.stderr.toString());
  await nativeAligned(app);
  if (from.selector) from = from.renderer ? await rendererPoint(from.selector) : await point(from.selector, from.where);
  if (to?.selector) to = to.renderer ? await rendererPoint(to.selector) : await point(to.selector, to.where);
  console.log(action, from, to ?? "");
  const args = [driver, String(facts.pid), action, String(facts.x + from.x), String(facts.y + from.y)];
  if (to) args.push(String(facts.x + to.x), String(facts.y + to.y));
  const result = Bun.spawnSync(args);
  assert.equal(result.exitCode, 0, result.stderr.toString());
}
async function picks(count: number) { await waitBrowser(() => app.main(`${subject()}.selections?.length===${count}`), `${count} picks`); }
async function dragPick(source: "page" | "bar", destination: string) {
  const from = source === "page" ? await point("#pick") : await app.main<Point>(`(async()=>{const b=${subject()}.view.getBounds();const r=await ${browser}.pointer.view.webContents.executeJavaScript("(()=>{const r=document.querySelector('[data-slot=selection-bar]').getBoundingClientRect();return {x:r.x+24,y:r.y+r.height/2}})()");return {x:b.x+r.x,y:b.y+r.y}})()`);
  await input("drag", from, await rendererPoint(destination));
  await waitBrowser(() => app.main(`!${browser}.selection.dragTab && !${browser}.selection.down`), "drag settled");
}
try {
  const other = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Pointer destination" }) });
  await app.page.reload(); await shellReady(app, "en"); await app.click("General");
  await app.call("open");
  tab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: server.url.href });
  await app.click("Show browser"); await app.call("activate", { id: tab }); await nativeAligned(app);
  await waitBrowser(() => page("document.title==='Atlas search workspace'"), "search workspace loaded");
  await app.main(`(()=>{globalThis.pointerProof={raw:[],forwarded:[],drags:[],hidden:[],uncaught:[],dialogs:[],warnings:0};
    process.on('uncaughtExceptionMonitor',e=>pointerProof.uncaught.push(String(e)));
    const electron=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})('electron');
    electron.dialog.showErrorBox=(...args)=>pointerProof.dialogs.push(args);
    const warn=console.warn;console.warn=(...args)=>{if(String(args[0]).includes('[browser-pointer]'))pointerProof.warnings++;warn(...args)};
  })()`);
  // A page's preload must answer drag IPC even before an overlay exists.
  await app.call("control", { id: tab, holder: "user" }); await nativeAligned(app);
  assert.equal(await app.main(`Boolean(${browser}.pointer.view)`), false);
  await input("drag", await point("#first"), await point("#second"));
  await waitBrowser(() => page("list.children[1].id==='first'"), "native list drag before first overlay");
  writeFileSync(join(evidence, "before-overlay-drag.json"), JSON.stringify(await page("({order:[...list.children].map(n=>n.id),drags:proof.drags})")));
  await page("list.prepend(first);proof.drags=0;proof.events=[]");
  await app.main(`${subject()}.view.webContents.sendInputEvent({type:'keyDown',keyCode:'S',modifiers:['meta','shift']})`);
  await waitBrowser(() => app.main(`${subject()}.picking && ${browser}.pointer.ready`), "shortcut pick overlay");
  await app.main(`${browser}.pointer.view.webContents.on('input-event',(_e,i)=>pointerProof.raw.push(i));const forward=${subject()}.view.webContents.sendInputEvent.bind(${subject()}.view.webContents);${subject()}.view.webContents.sendInputEvent=i=>{pointerProof.forwarded.push(i);forward(i)};`);
  await app.main(`(()=>{const p=${browser}.pointer,hide=p.hide;p.hide=function(){pointerProof.hidden.push({drag:${browser}.selection.dragTab,covered:${subject()}.covered,stack:Error().stack});return hide.call(this)};const s=${browser}.selection,drag=s.drag;s.drag=function(t,i,phase){pointerProof.drags.push({phase,i});return drag.call(this,t,i,phase)}})()`);
  await app.shot("before-native-input", true);
  await input("click", await point("#pick")); await picks(1);
  assert.equal(await app.main(`${subject()}.selections[0].title`), "Browser input and selection guide");
  await input("wheel", await point("#text"));
  await waitBrowser(() => page("scrollY>0"), "pick-mode wheel reaches page");
  await page("scrollTo(0,0)");
  await showPickSidebar(app); await nativeAligned(app);
  const row = `[data-tree-item="s:${other.session.id}"] [data-test-class~="tree-row"]`;
  for (const source of ["page", "bar"] as const) {
    if (source === "bar") {
      await app.call("selection-command", { id: tab, op: "clear" });
      await input("click", await point("#pick")); await picks(1);
    }
    const chipCount = source === "page" ? 1 : 2;
    await dragPick(source, '[data-test-class="composer-card"]');
    await waitBrowser(() => app.page.expression(`document.querySelectorAll('[data-slot=element-chip]').length===${chipCount}`), `${source} to composer`);
    const scraps = await app.gateway.api<{ items: unknown[] }>("/library?kind=scrap");
    await dragPick(source, '[data-test-class="library-entry"]');
    await waitBrowser(async () => (await app.gateway.api<{ items: unknown[] }>("/library?kind=scrap")).items.length === scraps.items.length + 1, `${source} to Library`);
    await dragPick(source, row);
    await app.click("Pointer destination");
    await waitBrowser(() => app.page.expression(`document.querySelectorAll('[data-slot=element-chip]').length===${chipCount}`), `${source} to conversation`);
    await app.click("General"); await app.call("activate", { id: tab }); await nativeAligned(app);
  }
  await app.call("pick", { id: tab, value: false });
  await input("click", await point("#link")); await waitBrowser(() => page("proof.clicks===1"), "forwarded link click");
  await input("right", await point("#text")); await waitBrowser(() => page("proof.right===1"), "forwarded context menu");
  await input("double", await point("#double")); await waitBrowser(() => page("proof.double===1"), "forwarded double click");
  await input("drag", await point("#text", 0.05), await point("#text", 0.8));
  assert.ok(await page<string>("getSelection().toString()"), "native text drag selected text");
  await input("drag", await point("#range", 0.2), await point("#range", 0.8));
  await waitBrowser(() => page("Number(range.value)>60"), "range drag reaches page");
  await input("drag", await point("#first"), await point("#second"));
  await waitBrowser(() => page("list.children[1].id==='first'"), "native draggable list reordered");
  await input("wheel", await point("#text")); await waitBrowser(() => page("scrollY>0"), "direct wheel reaches page");
  await page("scrollTo(0,0)");
  // Release before capture resolves: replay the complete gesture after the hit,
  // rather than starting a stuck drag after the physical mouseUp has passed.
  await app.call("pick", { id: tab, value: true });
  await app.call("selection-command", { id: tab, op: "clear" });
  await app.main(`(()=>{const s=${browser}.selection,hit=s.hit.bind(s);s.hit=async(...args)=>{const item=await hit(...args);s.hit=hit;return new Promise(done=>{globalThis.releasePick=()=>done(item)})}})()`);
  await input("drag", await point("#pick"), await rendererPoint('[data-test-class="composer-card"]'));
  await waitBrowser(() => app.main(`Boolean(globalThis.releasePick && ${browser}.selection.down?.ended)`), "capture held past physical release");
  writeFileSync(join(evidence, "late-capture.json"), JSON.stringify(await app.main(`({ended:${browser}.selection.down.ended,moved:${browser}.selection.down.moved})`)));
  await app.main("releasePick();delete globalThis.releasePick"); await picks(1);
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-slot=element-chip]').length===3"), "late capture still drops into composer");
  await app.call("pick", { id: tab, value: false });
  const secondTab = await app.call<string>("create", { owner: "conversation:general", url: server.url.href + "?second" });
  await waitBrowser(() => app.main(`${browser}.tabs.get(${JSON.stringify(secondTab)}).view.webContents.getTitle()==='Atlas secondary workspace'`), "second tab loaded");
  await app.call("activate", { id: tab }); await nativeAligned(app);
  writeFileSync(join(evidence, "tabs-before.json"), JSON.stringify(await app.call("state")));
  await app.page.expression("window.tabTrace=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])document.addEventListener(type,e=>window.tabTrace.push({type,x:e.clientX,y:e.clientY,buttons:e.buttons,target:e.target.outerHTML?.slice(0,180),dragging:document.querySelector('[data-slot=tab-strip] [data-dragging]')?.dataset.dragging}),true)");
  await app.main(`(()=>{const b=${browser},move=b.move;globalThis.tabMoves=[];b.move=function(i){tabMoves.push(i);return move.call(this,i)}})()`);
  await waitBrowser(() => app.page.expression("[...document.querySelectorAll('[data-slot=tab-strip] [role=tab]')].every(n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.x+20,r.y+r.height/2))})"), "both tabs exposed after drop toast");
  const tabs = await app.page.expression<Array<{ label: string; x: number; y: number }>>("[...document.querySelectorAll('[data-slot=tab-strip] [role=tab]')].map(n=>{const r=n.getBoundingClientRect();return {label:n.getAttribute('aria-label'),x:r.x+20,y:r.y+r.height/2}})");
  assert.equal(tabs.length, 2);
  await input("drag", tabs[0]!, tabs[1]!);
  writeFileSync(join(evidence, "tab-gesture.json"), JSON.stringify({ trace: await app.page.expression("tabTrace"), moves: await app.main("tabMoves"), state: await app.call("state") }, null, 2));
  await waitBrowser(() => app.page.expression(`document.querySelector('[data-slot=tab-strip] [role=tab]').getAttribute('aria-label')===${JSON.stringify(tabs[1]!.label)}`), "tab row reordered with OS drag");
  assert.ok(secondTab);
  assert.notEqual(tabs[0]!.label, tabs[1]!.label, "distinct tab labels make reorder observable");
  // Invalid metadata and a synchronous native failure are contained, logged once.
  await app.main(`(()=>{const p=${browser}.pointer;p.guard(()=>p.mouse({type:'mouseWheel',modifiers:[],_modifiers:0}));p.guard(()=>p.mouse({type:'pointerDown',x:1,y:2}));
    const t=${subject()},send=t.view.webContents.sendInputEvent;t.view.webContents.sendInputEvent=()=>{throw Error('injected native failure')};
    p.guard(()=>p.mouse({type:'mouseDown',x:10,y:10}));p.guard(()=>p.mouse({type:'mouseDown',x:10,y:10}));t.view.webContents.sendInputEvent=send;
  })()`);
  const proof = await app.main<{ raw: unknown[]; forwarded: unknown[]; uncaught: unknown[]; dialogs: unknown[]; warnings: number }>("pointerProof");
  assert.deepEqual(proof.uncaught, []); assert.deepEqual(proof.dialogs, []); assert.equal(proof.warnings, 1);
  assert.ok(proof.raw.length > 0 && proof.forwarded.length > 0);
  await app.shot("after-native-input", true);
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, elapsedMs: Date.now() - started, proof, page: await page("proof") }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), main: app.lastMain(), proof: await app.main("pointerProof").catch(() => null), state: await app.call("state"), page: await page("({proof,range:range.value,text:getSelection().toString(),list:list.innerText})").catch(() => null) }, null, 2));
  await app.shot("failure", true).catch(() => {}); throw error;
} finally { server.stop(true); await app.stop(); }
