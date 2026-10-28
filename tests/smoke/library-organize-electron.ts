import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
/** Public Library paths in an isolated real App; CDP input, stub models, stills only. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { electronViewInput } from "../support/electron-view-input";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, shellReady } from "../support/browser-shell-acceptance";
import { showPickSidebar, overlayRead } from "../support/browser-pick-acceptance";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE!;
const phase = process.env.BUTLER_LIBRARY_SMOKE_PHASE ?? "all";
assert.ok(["all", "organize", "matrix"].includes(phase));
assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
let lastUI = "";
const clickSelector = app.page.clickSelector, clickText = app.page.clickText;
app.page.clickSelector = async (selector) => {
  lastUI = selector;
  await waitBrowser(() => app.page.expression(`(()=>{
    const n=document.querySelector(${JSON.stringify(selector)});
    if(!n || n.disabled || n.getAttribute('aria-disabled')==='true') return false;
    // Navigation can publish Library while its workspace is still sliding after sidebar dismissal.
    for(let parent=n;parent;parent=parent.parentElement) if(parent.getAnimations().some(a=>a.playState==='running' && a.timeline instanceof DocumentTimeline && a.effect?.getComputedTiming().iterations!==Infinity)) return false;
    return true;
  })()`), `click target ready: ${selector}`);
  await clickSelector(selector);
};
app.page.clickText = async (text, scope) => { lastUI = `${scope}: ${text}`; await clickText(text, scope); };
type Point = { x: number; y: number };
type Item = { id: string; title: string; group?: string; tags: string[] };
const browser = "globalThis.browserAgentSubject";
let tab = "";
let held: Point | undefined;
const subject = () => `${browser}.tabs.get(${JSON.stringify(tab)})`;
const notes: unknown[] = [];
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const rows = async (kind = "scrap") => (await app.gateway.api<{ items: Item[] }>(`/library?kind=${kind}`)).items;
async function box(selector: string) {
  await waitBrowser(() => app.page.expression(`document.querySelector(${JSON.stringify(selector)})!==null`), `input target loaded: ${selector}`);
  return app.page.expression<Point>(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
}
const viewInput = electronViewInput(app);
async function input(action: string, from: Point, to?: Point | string) {
  await viewInput(action, from, to);
  if (action === "down" || action === "dragmove") held = from;
  if (action === "up") held = undefined;
}
async function fill(selector: string, text: string) {
  await waitBrowser(() => app.page.expression(`document.querySelector(${JSON.stringify(selector)}) instanceof HTMLInputElement`), `editable input ready: ${selector}`);
  await app.page.expression(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(text)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function library() {
  await showPickSidebar(app);
  await app.click(await app.page.expression("document.documentElement.lang.startsWith('ko')?'서랍':'Library'"));
  await waitBrowser(() => app.page.expression("document.querySelector('[data-group-tile]')!==null && document.querySelector('[data-library-item]')!==null"), "groups and saved items loaded");
  await waitBrowser(() => app.main(`!${subject()}.attached`), "native browser detached from Library");
  await app.page.expression("document.fonts.ready.then(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true)))))");
}
async function picking() {
  await app.click(getAppCopy("en-US").space.general); await app.call("activate", { id: tab });
  if (!await app.page.expression("document.querySelector('[data-slot=browser-pane]')!==null")) await app.click("Show browser");
  await nativeAligned(app); await showPickSidebar(app);
  await app.call("pick", { id: tab, value: true });
  await waitBrowser(() => app.main(`${browser}.pointer.ready && ${subject()}.picking`), "native pick overlay ready");
  const point = await app.main<Point>(`(async()=>{const t=${subject()},b=t.view.getBounds();const r=await t.view.webContents.executeJavaScript("(()=>{const r=document.querySelector('h1').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");return {x:b.x+r.x,y:b.y+r.y}})()`);
  await input("move", point);
  await waitBrowser(() => overlayRead<boolean>(app, "document.querySelector('[data-pick-outline=hover]')!==null"), "page heading hovered");
  if (await app.main<number>(`(${subject()}.selections?.length??0)`) === 0) await input("click", point);
  await waitBrowser(() => app.main(`${subject()}.selections?.length===1`), "heading picked by native click");
  return point;
}
async function nativeDrops(group: string) {
  await library();
  await input("drag", await box('[data-library-item="loose-0"] [data-library-card]'), await box(`[data-group-tile="${group}"]`));
  await waitBrowser(async () => (await rows()).find((item) => item.id === "loose-0")?.group === group, "native card to group tile persisted");
  await app.shot("native-card-to-tile");
  let point = await picking();
  const before = (await rows()).length;
  await input("drag", point, await box('[data-test-class="library-entry"]'));
  await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=library-saved-chooser]')!==null"), "pick drop offers chooser");
  assert.equal((await rows()).length, before + 1);
  const source = await app.main<string>(`${app.win}.getMediaSourceId()`);
  const capture = Bun.spawnSync([process.env.BUTLER_WINDOW_CAPTURE_EXECUTABLE!, source.split(":")[1]!, join(evidence, "native-pick-chooser.png")]);
  assert.equal(capture.exitCode, 0, capture.stderr.toString());
  writeFileSync(join(evidence, "native-pick-chooser-renderer.png"), await app.page.screenshot());
  notes.push({ chooserFocus: await app.page.expression("({tag:document.activeElement.tagName,text:document.activeElement.textContent})") });
  await input("key", { x: 0, y: 0 }, "Enter");
  await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=library-saved-chooser]')===null"), "Enter keeps ungrouped save");
  point = await picking();
  const barPoint = await app.main<Point>(`(async()=>{const p=${browser}.pointer.view,b=p.getBounds();const r=await p.webContents.executeJavaScript("(()=>{const n=[...document.querySelectorAll('[data-slot=selection-bar] button')].find(n=>n.textContent.trim()==='Scrap');const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");return {x:b.x+r.x,y:b.y+r.y}})()`);
  const barSaved = (await rows()).length;
  await input("click", barPoint);
  await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=library-saved-chooser]')!==null"), "SelectionBar Scrap opens the same chooser");
  assert.equal((await rows()).length, barSaved, "saving a kept pick again updates its item without duplicating it");
  await input("key", { x: 0, y: 0 }, "Enter");
  await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=library-saved-chooser]')===null"), "SelectionBar default leaves ungrouped");
  point = await picking();
  const grouped = (await rows()).filter((item) => item.group === group).length;
  await input("down", point); await input("dragmove", { x: point.x + 10, y: point.y });
  await waitBrowser(() => app.main(`${browser}.selection.dragTab===${JSON.stringify(tab)}`), "native picked drag starts before leaving browser");
  await input("dragmove", await box('[data-test-class="library-entry"]'));
  await waitBrowser(() => app.page.expression("document.querySelector('[data-group-tile]')!==null"), "600ms dwell opens Library during native drag");
  await input("dragmove", await box(`[data-group-tile="${group}"]`));
  await input("up", await box(`[data-group-tile="${group}"]`));
  await waitBrowser(async () => (await rows()).filter((item) => item.group === group).length === grouped + 1, "dwelled pick to tile persisted");
  notes.push({ nativeDrops: ["card → tile", "pick → chooser", "Enter → ungrouped", "SelectionBar → chooser", "dwell → tile"] });
  writeFileSync(join(evidence, "native-result.json"), JSON.stringify({ ok: true, notes }, null, 2));
}
async function organizing(group: string, other: string) {
  await library();
  await input("drag", await box(`[data-group-tile="${other}"]`), await box(`[data-group-tile="${group}"]`));
  await waitBrowser(async () => (await app.gateway.api<{ groups: { id: string }[] }>("/library/groups?kind=scrap")).groups[0]?.id === other, "tile order persisted");
  await app.page.clickSelector('[data-library-kind=scrap] button');
  await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=library-group-chips]')!==null"), "kind view opens");
  await input("drag", await box('[data-library-item="loose-3"] [data-library-card]'), await box(`[data-group-chip="${other}"]`));
  await waitBrowser(async () => (await rows()).find((item) => item.id === "loose-3")?.group === other, "native card to group chip persisted");
  await input("drag", await box(`[data-group-chip="${group}"]`), await box(`[data-group-chip="${other}"]`));
  await waitBrowser(async () => (await app.gateway.api<{ groups: { id: string }[] }>("/library/groups?kind=scrap")).groups[0]?.id === group, "chip order persisted");
  await app.page.clickSelector('[data-library-item="loose-1"] button[aria-label="More"]');
  await app.page.clickText("Rename", "[role=menuitem]");
  await fill('[data-library-item="loose-1"] input', "Renamed scrap"); await app.page.press("Enter");
  await waitBrowser(async () => (await rows()).find((item) => item.id === "loose-1")?.title === "Renamed scrap", "inline rename persisted");
  await waitBrowser(() => app.page.expression("document.querySelector('[data-library-item=\"loose-1\"]')?.textContent.includes('Renamed scrap')===true"), "renamed card refresh completed");
  for (const id of ["loose-1", "loose-2"]) await app.page.clickSelector(`[data-library-item="${id}"] [role=checkbox]`);
  await app.page.clickText("Edit tags…", '[data-test-class=library-selection] button');
  await fill('[role=dialog] [role=combobox]', "Shared"); await app.page.press("Enter");
  await fill('[role=dialog] [role=combobox]', "FilterTag"); await app.page.press("Enter"); await app.page.clickText("Save", '[role=dialog] button');
  await waitBrowser(async () => { const items = await rows(); return ["loose-1", "loose-2"].every((id) => items.find((item) => item.id === id)?.tags.includes("Shared")); }, "bulk tags saved on both items");
  await waitBrowser(() => app.page.expression("['loose-1','loose-2'].every(id=>document.querySelector('[data-library-item=\"'+id+'\"]')?.textContent.includes('Shared') || document.querySelector('[data-library-item=\"'+id+'\"]')?.textContent.includes('+1'))"), "tagged cards refreshed");
}
async function filtersAndTags() {
  await app.page.clickSelector('[data-filter=tags]'); await app.page.clickText("Manage tags…", '[role=menuitem]');
  await app.page.clickSelector('[data-library-tag="Shared"] button[aria-label="More"]'); await app.page.clickText("Rename", '[role=menuitem]');
  await fill('[role=dialog] input[aria-label="Name: Shared"]', "Review");
  await app.page.clickText("Rename", '[role=dialog] button:not(:disabled)');
  await waitBrowser(async () => (await rows()).filter((item) => item.tags.includes("Review")).length === 2, "tag rename updates items");
  await app.page.clickSelector('[data-library-tag="Review"] button[aria-label="More"]'); await app.page.clickText("Rename", '[role=menuitem]');
  await fill('[role=dialog] input[aria-label="Name: Review"]', "Reading");
  await app.page.clickText("Merge", '[role=dialog] button');
  await waitBrowser(async () => !(await rows()).some((item) => item.tags.includes("Review")), "tag merge replaces old label");
  await app.shot("tag-management"); await app.page.press("Escape");
  const tags = (await app.gateway.api<{ tags: { name: string; count: number }[] }>("/library/facets?kind=scrap")).tags;
  await app.page.clickSelector('[data-filter=tags]');
  for (const name of ["Reading", "FilterTag"]) {
    const tag = tags.find((tag) => tag.name === name)!;
    await app.page.clickText(`${tag.name} · ${tag.count}`, '[role=menuitemcheckbox]');
  }
  await app.page.press("Escape");
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-library-item]').length===2"), "AND tags filter both renamed items");
  await app.shot("combined-tags");
  await app.page.clickText("Clear all", '[data-test-class=library-filter-chips] button');
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-library-item]').length>2"), "clear restores complete list");
}
async function removalAndGroups() {
  for (const id of ["loose-1", "loose-2"]) await app.page.clickSelector(`[data-library-item="${id}"] [role=checkbox]`);
  await app.page.clickText("Edit tags…", '[data-test-class=library-selection] button');
  await app.page.clickSelector('[role=dialog] button[aria-label="Remove FilterTag"]');
  await app.page.clickText("Save", '[role=dialog] button');
  await waitBrowser(async () => !(await rows()).some((item) => item.tags.includes("FilterTag")), "bulk tag removal keeps every item");
  await app.page.clickText("Cancel", '[data-test-class=library-selection] button');
  await app.page.clickText("New group", '[data-test-class=library-group-chips] button');
  await fill('[role=dialog] input', "Temporary group"); await app.page.clickText("Create", '[role=dialog] button');
  const groups = async () => (await app.gateway.api<{ groups: { id: string; name: string }[] }>("/library/groups?kind=scrap")).groups;
  await waitBrowser(async () => (await groups()).some((group) => group.name === "Temporary group"), "group created");
  const id = (await groups()).find((group) => group.name === "Temporary group")!.id;
  await app.page.clickSelector(`[data-group-chip="${id}"]`);
  await app.page.clickSelector('[data-test-class=library-group-chips] button[aria-label="More"]'); await app.page.clickText("Rename", '[role=menuitem]');
  await fill('[role=dialog] input', "Renamed group"); await app.page.clickText("Save", '[role=dialog] button');
  await waitBrowser(async () => (await groups()).some((group) => group.id === id && group.name === "Renamed group"), "group renamed");
  await app.page.clickSelector('[data-test-class=library-group-chips] button[aria-label="More"]'); await app.page.clickText("Ungroup", '[role=menuitem]');
  await app.page.clickText("Ungroup", '[role=dialog] button');
  await waitBrowser(async () => !(await groups()).some((group) => group.id === id), "group removed while items stay");
  await app.gateway.api("/library/items", { method: "PATCH", body: JSON.stringify({ ids: [(await rows("bookmark")).find((item) => item.title === "Reference 0")!.id], addTags: ["Temporary tag"] }) });
  await app.page.clickSelector('[data-filter=tags]'); await app.page.clickText("Manage tags…", '[role=menuitem]');
  await app.page.clickSelector('[data-library-tag="Temporary tag"] button[aria-label="More"]'); await app.page.clickText("Delete tag", '[role=menuitem]');
  await waitBrowser(async () => !(await rows("bookmark")).some((item) => item.tags.includes("Temporary tag")), "shared tag deletion preserves bookmark");
  assert.equal((await rows("bookmark")).length, 3);
  await app.page.press("Escape");
  notes.push({ bulkTags: ["add", "remove", "rename", "merge", "delete"], groups: ["create", "rename", "ungroup", "tile order", "chip order"] });
}
// Kept separate from the native gestures so the locale/size matrix has no transient input state.
async function matrix(group: string) {
  for (const language of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100, 390]) {
    await app.main(`${app.win}.setMinimumSize(0,0)`);
    await app.settings(language, theme, width); await library();
    const prefix = `${language}-${theme}-${width}`;
    await app.shot(`${prefix}-main`);
    await waitBrowser(() => app.page.expression("document.querySelector('[data-library-kind=document] [data-library-card]')!==null"), "document preview loaded");
    const documentGap = await app.page.expression<number>("(()=>{const c=document.querySelector('[data-library-kind=document] [data-library-card]'),tag=c.querySelector('[data-kind=document] [data-tone=neutral]'),line=c.querySelector('[data-kind=document] [aria-hidden=true] span');return line.getBoundingClientRect().top-tag.getBoundingClientRect().bottom})()");
    assert.ok(documentGap >= 0, `document kind badge clears preview: ${documentGap}`);
    const layouts = await app.page.expression<{ columns: number; overflow: boolean }[]>(`[...document.querySelectorAll('[data-library-kind] [data-columns]')].map(n=>({columns:getComputedStyle(n).gridTemplateColumns.split(' ').length,overflow:n.scrollWidth>n.clientWidth+1}))`);
    assert.ok(layouts.length > 0);
    assert.ok(layouts.every((layout) => !layout.overflow), "all Library grids fit their container");
    if (width === 390) assert.ok(layouts.every((layout) => layout.columns === 2), "phone grids have two columns");
    await app.page.expression("(()=>{const n=document.querySelector('[data-test-class=library-page]');n.scrollTop=n.scrollHeight})()");
    await app.shot(`${prefix}-main-lower`);
    await app.page.expression("document.querySelector('[data-test-class=library-page]').scrollTop=0");
    await app.page.clickSelector(`[data-group-tile="${group}"] [role=button]`);
    await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=library-group-chips]')!==null"), "tile selects kind group");
    await waitBrowser(() => app.page.expression(`document.querySelector('[data-group-chip="${group}"]')?.getAttribute('aria-pressed')==='true'`), "opened tile selects its group chip");
    await app.shot(`${prefix}-group`);
    await app.page.clickSelector('[data-library-item="loose-0"] [data-library-card] [role=button]');
    await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=library-detail]')!==null"), "scrap detail opens");
    await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=scrap-frame]')!==null"), "saved HTML preview loaded");
    if (prefix === "ko-light-1440") {
      await fill('#library-item-name', "Detail renamed"); await app.page.press("Enter");
      await waitBrowser(async () => (await rows()).find((item) => item.id === "loose-0")?.title === "Detail renamed", "detail rename persisted");
      await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=custom-titlebar]').textContent.includes('Detail renamed')"), "titlebar reflects detail rename");
    }
    await app.shot(`${prefix}-detail`);
    assert.equal(await app.page.expression("document.querySelectorAll('[role=dialog]').length"), 0, "detail replaces legacy dialog");
    await app.page.expression("document.activeElement.blur()");
    await app.main(`${app.win}.webContents.sendInputEvent({type:'keyDown',keyCode:'Left',modifiers:['alt']});${app.win}.webContents.sendInputEvent({type:'keyUp',keyCode:'Left',modifiers:['alt']})`);
    await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=library-detail]')===null && document.querySelector('[data-test-class=library-group-chips]')!==null"), "Alt+Left goes back to selected group");
    await app.main(`${app.win}.webContents.sendInputEvent({type:'keyDown',keyCode:'[',modifiers:['meta']});${app.win}.webContents.sendInputEvent({type:'keyUp',keyCode:'[',modifiers:['meta']})`);
    await waitBrowser(() => app.page.expression("document.querySelector('[data-test-class=library-group-chips] button')?.getAttribute('aria-pressed')==='true'"), "Command+[ goes back to all scraps");
    await app.page.clickSelector('[data-test-class=titlebar-back]');
    await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-library-kind]').length===4 && document.querySelector('[data-test-class=titlebar-back]')===null"), "back button returns to main and hides");
    for (const kind of ["document", "bookmark", "output"]) {
      await library();
      await app.page.clickSelector(`[data-library-kind=${kind}] button`);
      await waitBrowser(() => app.page.expression(`document.querySelectorAll('[data-library-kind]').length===1 && document.querySelector('[data-library-kind=${kind}]')!==null`), `${kind} View all enters its full view`);
      if (kind !== "bookmark") assert.equal(await app.page.expression("document.querySelectorAll('[data-test-class=library-group-chips]').length"), 0, "documents and outputs have filters without groups");
      await app.shot(`${prefix}-${kind}`);
    }
    notes.push({ language, theme, width, layouts, documentGap });
  }
}
try {
  await app.page.reload(); await shellReady(app, "en"); await app.click(getAppCopy("en-US").space.general); await app.call("open");
  tab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: app.url });
  await app.click("Show browser"); await app.call("activate", { id: tab }); await nativeAligned(app);
  const crop = await app.page.expression<string>("(()=>{const c=document.createElement('canvas');c.width=300;c.height=160;const x=c.getContext('2d');x.fillStyle='#f1f1f1';x.fillRect(0,0,300,160);x.fillStyle='#252525';x.font='bold 24px sans-serif';x.fillText('Saved heading',16,48);x.font='16px sans-serif';x.fillText('Complete saved content',16,90);return c.toDataURL('image/jpeg')})()");
  const groups: string[] = [];
  for (const name of ["Reading", "Travel", "Recipes", "Projects", "Ideas", "Empty"]) groups.push((await app.gateway.api<{ id: string }>("/library/groups", { method: "POST", body: JSON.stringify({ kind: "scrap", name }) })).id);
  for (let n = 0; n < 6; n++) await app.gateway.api("/library", { method: "POST", body: JSON.stringify({ id: `loose-${n}`, kind: "scrap", title: `Saved heading ${n}`, text: `Complete heading ${n}`, url: "https://example.com", site: "example.com", crop, capturedAt: new Date(Date.now() - n * 1000).toISOString(), tags: n % 2 ? ["Reading"] : [], snapshot: { html: '<!doctype html><html><body><h1>Saved heading</h1><p>Complete saved content</p></body></html>', width: 300, height: 160 } }) });
  for (let n = 0; n < 4; n++) await app.gateway.api("/library", { method: "POST", body: JSON.stringify({ id: `grouped-${n}`, kind: "scrap", title: `Reference clipping ${n}`, text: `Complete reference ${n}`, url: "https://reference.example/", site: "reference.example", crop, capturedAt: new Date(Date.now() - 60_000 - n * 1000).toISOString(), group: groups[0], tags: ["Reading"] }) });
  for (let n = 0; n < 3; n++) await app.gateway.api("/library", { method: "POST", body: JSON.stringify({ id: `bookmark-${n}`, kind: "bookmark", title: `Reference ${n}`, url: `https://reference${n}.example/`, folder: n ? "Reference" : "", capturedAt: new Date().toISOString(), tags: ["Reading"] }) });
  // Publishing a web output leaves its working files out of Library documents.
  const document = await app.gateway.api<{ id: string }>("/documents", { method: "POST", body: JSON.stringify({ title: "Reading notes", body: "# Reading notes\n\nComplete saved document content.", author: "user" }) });
  const documents = await rows("doc");
  assert.ok(documents.some((item) => item.id === document.id && item.title === "Reading notes"), "created document is listed in Library");
  writeFileSync(join(evidence, "seeded-documents.json"), JSON.stringify(documents, null, 2));
  await app.page.reload(); await shellReady(app, "en");
  if (phase === "all") await nativeDrops(groups[0]!);
  else await app.gateway.api("/library/items", { method: "PATCH", body: JSON.stringify({ ids: ["loose-0"], group: groups[0] }) });
  if (phase !== "matrix") {
    await organizing(groups[0]!, groups[1]!);
    await app.page.clickText("Cancel", '[data-test-class=library-selection] button');
    await filtersAndTags();
    await removalAndGroups();
  }
  if (phase !== "organize") await matrix(groups[0]!);
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, phase, notes }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), lastUI, notes, main: app.lastMain(), drag: await app.main(`({dragTab:${browser}.selection.dragTab, capture:${browser}.pointer.captureTab})`).catch(()=>null), preview: await app.page.expression("document.querySelector('[data-slot=drag-preview]')?.outerHTML").catch(()=>null), diagnostics: await app.page.diagnostics() }));
  await app.shot("failure").catch(() => {}); throw error;
} finally { if (held) await input("up", held).catch(() => {}); await app.stop(); }
