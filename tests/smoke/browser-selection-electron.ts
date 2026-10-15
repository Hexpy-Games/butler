/** S5: real overlay input → trusted App renderer drops, with isolated stub runtime. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, shellReady } from "../support/browser-shell-acceptance";
import { pointerAction } from "../support/browser-control-actions";
import { dragPreview, emptyPick, hoverPick, pickBadges, showPickSidebar } from "../support/browser-pick-acceptance";
import { bridgeBrowser, latestBrowser } from "../support/browser-agent-stub";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE!; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const started = Date.now(), app = await redesignApp(evidence);
const subject = (tab: string) => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)})`;
let tab = "";
async function pick(selector: string) {
  await waitBrowser(() => app.main("Boolean(globalThis.browserAgentSubject.pointer.view && globalThis.browserAgentSubject.pointer.ready)"), "pick overlay ready");
  const point = await app.main<{ x:number;y:number }>(`${subject(tab)}.view.webContents.executeJavaScript(${JSON.stringify(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)})`);
  const scale = await app.main<number>(`${subject(tab)}.bounds.scale ?? 1`);
  await app.main(`(()=>{const p=globalThis.browserAgentSubject.pointer.view.webContents;p.sendInputEvent({type:'mouseDown',x:${Math.round(point.x*scale)},y:${Math.round(point.y*scale)},button:'left',clickCount:1});p.sendInputEvent({type:'mouseUp',x:${Math.round(point.x*scale)},y:${Math.round(point.y*scale)},button:'left',clickCount:1});})()`);
}
async function selected(count: number) {
  await waitBrowser(async () => (await app.call<{ tabs: Array<{ id: string; selectionCount: number }> }>("state")).tabs.find(t => t.id === tab)?.selectionCount === count, `${count} tab picks`);
}
async function drag(selector: string, screenshot?: string) {
  if (!selector.includes("composer-card")) {
    await showPickSidebar(app);
    await nativeAligned(app);
  }
  const point = await app.page.expression<{ x: number; y: number }>(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const origin = await app.main<{ x:number;y:number }>(`${subject(tab)}.view.webContents.executeJavaScript('(()=>{const r=document.querySelector("h1").getBoundingClientRect();return {x:r.x+24,y:r.y+r.height/2}})()')`);
  const scale = await app.main<number>(`${subject(tab)}.bounds.scale ?? 1`);
  const x = Math.round(origin.x * scale), y = Math.round(origin.y * scale);
  await app.main(`(()=>{const p=globalThis.browserAgentSubject.pointer.view.webContents;p.sendInputEvent({type:"mouseDown",x:${x},y:${y},button:"left",clickCount:1});p.sendInputEvent({type:"mouseMove",x:${x+20},y:${y},button:"left",movementX:20,movementY:0});})()`);
  await waitBrowser(() => app.main("Boolean(globalThis.browserAgentSubject.selection.dragTab)"), "native overlay starts drag");
  await app.page.dragPointer(point.x, point.y);
  await dragPreview(app, false);
  if (screenshot) {
    await app.shot(screenshot, true);
    await app.page.dragPointer(900, 24);
    await dragPreview(app, true);
    await app.shot(screenshot.replace(/-(conversation|library|composer)-drop$/, "-invalid-drop"), true);
  }
  writeFileSync(join(evidence, `drag-${Date.now()}.json`), JSON.stringify(await app.page.expression(`(()=>{const n=document.elementFromPoint(${point.x},${point.y});return {hit:n?.outerHTML,drop:[...document.querySelectorAll(\'[data-slot="nav-drop-target"]\')].filter(n=>n.dataset.drop).map(n=>({drop:n.dataset.drop,html:n.outerHTML.slice(0,600)}))}})()`)));
  await app.page.pointerUp(screenshot ? 900 : point.x, screenshot ? 24 : point.y);
  await waitBrowser(() => app.main("!globalThis.browserAgentSubject.selection.dragTab"), "renderer ends native drag");
  await app.main(`globalThis.browserAgentSubject.pointer.view.webContents.sendInputEvent({type:"mouseUp",x:${x+20},y:${y},button:"left",clickCount:1})`);
  writeFileSync(join(evidence, `drop-${Date.now()}.json`), JSON.stringify(await app.page.expression("({events:window.dropPointerProof,toasts:[...document.querySelectorAll('[data-sonner-toast]')].map(n=>n.textContent)})")));
  await nativeAligned(app);
}
try {
  const shortcut = new URL("../../packages/butler-app/client/electron/butler-platform/browser-shortcuts.mjs", import.meta.url).href;
  const { isPickShortcut } = await import(shortcut);
  assert.ok(isPickShortcut({ type: "keyDown", key: "S", shift: true, control: true }, "win32"));
  assert.ok(!isPickShortcut({ type: "keyDown", key: "S", shift: true, meta: true }, "win32"));
  const other = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Pick destination" }) });
  await app.page.reload(); await shellReady(app, "en");
  await app.click("General");
  await app.page.expression("window.dropPointerProof=[];window.addEventListener('pointerup',e=>window.dropPointerProof.push({x:e.clientX,y:e.clientY,hit:document.elementFromPoint(e.clientX,e.clientY)?.outerHTML?.slice(0,400),invalid:document.querySelector('[data-slot=drag-preview]')?.dataset.invalid}),true);window.selectionDragProof=[];window.butlerBrowser.onElementDrag(e=>window.selectionDragProof.push({phase:e.phase,count:e.elements?.length,x:e.x,y:e.y}));");
  await app.call("open");
  tab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: app.url });
  await app.click("Show browser"); await app.call("activate", { id: tab }); await nativeAligned(app);
  await waitBrowser(() => app.main(`${subject(tab)}.status === "idle" && ${subject(tab)}.view.webContents.getTitle() === "Browser fixture"`), "fixture loaded");
  await app.main(`(()=>{const selection=globalThis.browserAgentSubject.selection,drag=selection.drag;globalThis.dragInputProof=[];
    selection.drag=function(t,input,phase){globalThis.dragInputProof.push({type:input.type,x:input.x,y:input.y,phase});return drag.call(this,t,input,phase)};})()`);
  // The production keyboard path must enter picking, using the platform modifier.
  await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents.sendInputEvent({type:'keyDown',keyCode:'S',modifiers:['meta','shift']})`);
  await waitBrowser(() => app.page.expression("document.querySelector('[data-slot=page-band]')?.dataset.tone==='pick'"), "keyboard pick mode");
  await pick("h1"); await selected(1);
  const picked = await app.main<any>(`${subject(tab)}.selections[0]`);
  assert.ok(picked.cropRect.width < picked.rect.width / 2, "heading crop excludes block whitespace");
  assert.ok(picked.cropRect.height > 0);
  assert.equal(picked.text, "Browser fixture"); assert.ok(picked.crop.startsWith("data:image/jpeg;base64,"));
  await pick("p"); await selected(2);
  const mine = await app.call<string>("create", { url: app.url });
  await app.call("activate", { id: mine }); await app.call("activate", { id: tab }); await selected(2);
  const raw = await app.internal("tab.selection", tab); assert.equal(raw.status, "ok");
  assert.equal(raw.untrusted_content.elements.length, 2); assert.equal(raw.untrusted_content.kind, "web_page_data");
  const wrong = await app.internal("tab.selection", tab, {}, other.session.id); assert.equal(wrong.reason, "not_your_tab");
  // Public model tool discovery and shaping, using a local scripted provider.
  app.stub.set([() => ({ name: "tool_describe", arguments: { ids: ["native:browser_selection"] } }), () => bridgeBrowser("browser_selection", { tab }), request => { const result = latestBrowser(request, "tab"); assert.equal((result.untrusted_content as any).elements.length, 2); return null; }]);
  await app.send("Read the picked elements"); await app.delivered();
  assert.ok(!JSON.stringify(app.stub.results).includes("stubFailure"), "public selection tool result assertion passed");
  await app.call("pick", { id: tab, value: true });
  // Keep sidebar expanded for the drop, following the existing peek/open action.
  await showPickSidebar(app);
  await nativeAligned(app);
  await drag('[data-tree-item="s:' + other.session.id + '"] [data-test-class~="tree-row"]');
  await app.click("Pick destination");
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-slot=element-chip]').length===2"), "other conversation draft has chips");
  await app.page.reload(); await shellReady(app, "en");
  await app.page.expression("window.dropPointerProof=[];window.addEventListener('pointerup',e=>window.dropPointerProof.push({x:e.clientX,y:e.clientY,hit:document.elementFromPoint(e.clientX,e.clientY)?.outerHTML?.slice(0,400),invalid:document.querySelector('[data-slot=drag-preview]')?.dataset.invalid}),true);window.selectionDragProof=[];window.butlerBrowser.onElementDrag(e=>window.selectionDragProof.push({phase:e.phase,count:e.elements?.length,x:e.x,y:e.y}));");
  await app.click("Pick destination");
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-slot=element-chip]').length===2"), "destination chips survive reload");
  await waitBrowser(() => app.page.expression("(()=>{const images=[...document.querySelectorAll('[data-slot=element-chip] img')];return images.length===2 && images.every(img=>img.complete && img.naturalWidth>0)})()"), "restored chip images loaded");
  await app.click("General"); await app.call("activate", { id: tab }); await nativeAligned(app);
  await drag('[data-test-class="library-entry"]');
  await waitBrowser(async () => (await app.gateway.api<{ items: unknown[] }>("/library?kind=scrap")).items.length === 2, "Library drop saves scraps");
  await drag('[data-test-class="composer-card"]');
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-slot=element-chip]').length===2"), "composer accepts elements");
  await app.call("pick", { id: tab, value: false });
  await app.call("control", { id: tab, holder: "agent" });
  await pointerAction(app, tab, "fill");
  assert.equal(await app.main(`${subject(tab)}.view.webContents.executeJavaScript('document.querySelector("input").value')`), "Fixture note");
  assert.equal(await app.main("globalThis.browserAgentSubject.pointer.view.webContents.executeJavaScript('document.querySelectorAll(\"polyline\").length')"), 0);
  await app.shot("typing-no-trail");
  const notes: unknown[] = [];
  for (const language of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.settings(language, theme, width); await app.call("activate", { id: tab }); await nativeAligned(app);
    const prefix = `${language}-${theme}-${width}`;
    await app.call("selection-command", { id: tab, op: "clear" });
    await app.call("pick", { id: tab, value: true }); await selected(0); await emptyPick(app);
    await app.shot(`${prefix}-before-first-pick`, true);
    await hoverPick(app, tab, "h1"); await app.shot(`${prefix}-hover`, true);
    await pick("h1"); await selected(1); await pickBadges(app, 1); await app.shot(`${prefix}-one-pick`, true);
    await pick("p"); await selected(2); await pickBadges(app, 2); await app.shot(`${prefix}-picking`, true);
    await showPickSidebar(app);
    await nativeAligned(app);
    await drag('[data-tree-item="s:' + other.session.id + '"] [data-test-class~="tree-row"]', `${language}-${theme}-${width}-conversation-drop`);
    await drag('[data-test-class="library-entry"]', `${language}-${theme}-${width}-library-drop`);
    await drag('[data-test-class="composer-card"]', `${language}-${theme}-${width}-composer-drop`);
    await selected(2);
    await app.call("pick", { id: tab, value: false }); await app.shot(`${language}-${theme}-${width}-kept-picks`);
    notes.push({ language, theme, width, picks: 2 });
  }
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, elapsedMs: Date.now() - started, notes }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), lastMain: app.lastMain() }));
  const state = await app.call("state").catch(() => null);
  const inputs = await app.main("globalThis.dragInputProof").catch(() => null);
  const diagnostics = await app.page.diagnostics().catch(() => null);
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), lastMain: app.lastMain(), state, inputs, diagnostics }));
  await app.shot("failure").catch(() => {}); throw error;
} finally { await app.stop(); }
