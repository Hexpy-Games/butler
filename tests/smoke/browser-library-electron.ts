/** S6 in the real Electron 44 App, using an isolated gateway and scripted model. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, shellReady } from "../support/browser-shell-acceptance";
const evidence = process.env.BUTLER_BROWSER_EVIDENCE!; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const started = Date.now(), app = await redesignApp(evidence);
async function align() {
  if (!await app.page.expression("Boolean(document.querySelector('[data-slot=browser-pane]'))")) await app.click(await app.page.expression("document.documentElement.lang.startsWith('ko')?'브라우저 열기':'Show browser'"));
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=browser-pane]'))"), "browser pane mounted");
  await nativeAligned(app);
}
async function fill(selector: string, value: string) {
  await app.page.expression(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function library() {
  if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').dataset.leftOpen==='false'")) await app.click("Show sidebar");
  await app.click("Library");
  await waitBrowser(() => app.page.expression("document.querySelector('[data-library-kind=output] [data-library-card]')!==null"), "produced output in Library");
}
async function itemMenu(kind: string, label: string) {
  await app.page.clickSelector(`[data-library-kind=${kind}] [data-library-card] button[aria-label="More"]`); await app.page.clickText(label, "[role=menuitem]");
}
try {
  const destination = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Library destination" }) });
  await app.page.reload(); await shellReady(app, "en"); await app.click("General"); await app.call("open");
  const tab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: app.url });
  await app.click("Show browser"); await app.call("activate", { id: tab }); await align();
  await waitBrowser(() => app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).title === 'Browser fixture'`), "bookmark source title loaded");
  await app.click("Add bookmark");
  await waitBrowser(async () => (await app.gateway.api<{ items:unknown[] }>("/library?kind=bookmark")).items.length===1, "address star saves bookmark");
  await app.click("Bookmarks"); await waitBrowser(() => app.page.expression("[...document.querySelectorAll('[role=menuitem]')].some(n=>n.textContent==='Browser fixture')"), "bookmark menu lists saved URL");
  await app.page.press("Escape");
  const crop = await app.main<string>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents.capturePage({x:36,y:36,width:300,height:80}).then(image=>'data:image/jpeg;base64,'+image.toJPEG(85).toString('base64'))`);
  for (const [id, title] of [["ko", "청자 전시회"], ["en", "CAFÉ recipe"], ["ja", "図書館の予約"]]) await app.gateway.api("/library", { method:"POST", body:JSON.stringify({ id, kind:"scrap", title, text:title, url:"https://example.com/", site:"example.com", crop, capturedAt:new Date().toISOString() }) });
  await library();
  app.stub.set([
    () => ({ name: "write_file", arguments: { path: "redesign/live.html", content: "<h1>Live Library</h1>" } }),
    () => ({ name: "output_publish", arguments: { path: "redesign", title: "Live Library" } }),
  ]);
  await app.send("Publish a second document"); await app.delivered();
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-library-kind=document] [data-library-card]').length===2 && document.querySelector('[data-library-kind=output]').textContent.includes('Live Library')"), "Library reflects committed documents and output without polling");
  assert.deepEqual(await app.page.expression("[...document.querySelectorAll('[data-library-kind]')].map(n=>n.dataset.libraryKind)"), ["scrap", "document", "bookmark", "output"]);
  for (const query of ["청자", "cafe", "図書館"]) {
    await fill('[aria-label="Search the library"]', query);
    await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-library-kind=scrap] [data-library-card]').length===1"), `Script15 UI search ${query}`);
  }
  await fill('[aria-label="Search the library"]', "");
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-library-kind=scrap] [data-library-card]').length===3"), "full scraps restored");
  await itemMenu("scrap", "Attach to chat"); await app.page.clickText("Library destination", "[role=dialog] button");
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-slot=element-chip]').length===1"), "scrap attaches to selected conversation");
  await app.page.reload(); await shellReady(app, "en"); await app.click("Library destination");
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-slot=element-chip]').length===1"), "Library attachment survives reload");
  await library(); await itemMenu("document", "Attach to chat"); await app.page.clickText("Library destination", "[role=dialog] button");
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-slot=element-chip], [data-slot=attachment-item]').length===2"), "document copied to destination draft");
  await library(); await itemMenu("bookmark", "Attach to chat"); await app.page.clickText("Library destination", "[role=dialog] button");
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-slot=element-chip], [data-slot=attachment-item]').length===3"), "bookmark attaches to destination draft");
  // Bookmark removal and re-add travel through the AddressField star.
  await app.click("General"); await app.call("activate", { id:tab }); await align(); await app.click("Bookmarked");
  await waitBrowser(async () => !(await app.gateway.api<{ items:unknown[] }>("/library?kind=bookmark")).items.length, "star removes bookmark");
  await app.click("Add bookmark");
  const emptyTab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out" });
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-library-card]'))"), "folder editor on new tab");
  await app.click("Folder"); await fill('[aria-label="Folder"]', "Work"); await app.page.clickText("OK", "[role=dialog] button");
  await waitBrowser(async () => (await app.gateway.api<{ items: Array<{ folder: string }> }>("/library?kind=bookmark")).items[0]?.folder === "Work", "folder saved");
  await app.call("close", { id: emptyTab });
  const notes=[];
  for (const language of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.settings(language, theme, width);
    const ko=language==="ko", label=ko?"서랍":"Library", search=ko?"서랍 검색":"Search the library";
    if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').dataset.leftOpen==='false'")) await app.click(ko?"사이드바 보기":"Show sidebar");
    await app.click(label); await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-library-kind=scrap] [data-library-card]').length===3"), "Library grid loaded");
    await app.shot(`${language}-${theme}-${width}-library`);
    await app.page.expression("(()=>{const s=document.querySelector('[data-test-class=\"library-page\"]');s.scrollTop=s.scrollHeight})()"); await app.shot(`${language}-${theme}-${width}-library-lower`);
    await app.page.expression("document.querySelector('[data-test-class=\"library-page\"]').scrollTop=0");
    await fill(`[aria-label="${search}"]`, "청자"); await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-library-kind=scrap] [data-library-card]').length===1"), "search visible"); await app.shot(`${language}-${theme}-${width}-search`);
    await fill(`[aria-label="${search}"]`, "no-match-unique"); await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-library-card]').length===0"), "empty search visible"); await app.shot(`${language}-${theme}-${width}-empty`);
    await fill(`[aria-label="${search}"]`, ""); await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-library-kind=scrap] [data-library-card]').length===3"), "grid restored");
    await app.page.clickSelector("[data-library-kind=scrap] [data-library-card] button"); await app.page.clickText(ko?"대화에 첨부":"Attach to chat", "[role=menuitem]"); await app.shot(`${language}-${theme}-${width}-attach`); await app.page.press("Escape"); await waitBrowser(() => app.page.expression("!document.querySelector('[role=dialog]')"), "attach dialog dismissed");
    await app.click(ko?"일반":"General"); await waitBrowser(() => app.page.expression("!document.querySelector('[data-test-class=library-page]')"), "sidebar returns to conversation"); await app.call("activate", { id:tab }); await align(); await app.shot(`${language}-${theme}-${width}-star`);
    await app.click(ko?"북마크":"Bookmarks"); await waitBrowser(() => app.page.expression("document.querySelector('[role=menuitem]')!==null"), "bookmark menu visible"); await app.shot(`${language}-${theme}-${width}-bookmarks-menu`);
    await app.page.clickText("Work", "[role=menuitem]"); await waitBrowser(() => app.page.expression("[...document.querySelectorAll('[role=menuitem]')].some(n=>n.textContent==='Browser fixture')"), "folder submenu visible"); await app.shot(`${language}-${theme}-${width}-folder-menu`, true); await app.page.press("Escape"); await app.page.press("Escape");
    const fresh = await app.call<string>("create", { owner:"conversation:general", profile:"signed_out" });
    await waitBrowser(() => app.page.expression("document.querySelector('[data-library-card]')!==null"), "new tab bookmark grid"); await app.shot(`${language}-${theme}-${width}-new-tab`);
    await app.click("Work"); await app.shot(`${language}-${theme}-${width}-folder`); await app.page.press("Escape"); await app.call("close", { id: fresh });
    notes.push({ language, theme, width });
  }
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok:true, elapsedMs:Date.now()-started, notes, destination:destination.session.id }, null, 2));
} catch (error) {writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error:String(error), lastMain:app.lastMain(), diagnostics:await app.page.diagnostics() }));await app.shot("failure").catch(()=>{});throw error;}
finally {await app.stop();}
