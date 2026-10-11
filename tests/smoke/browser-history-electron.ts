/** Functional history acceptance in the real App with disposable data and no live model. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { shellReady } from "../support/browser-shell-acceptance";
const evidence = process.env.BUTLER_BROWSER_EVIDENCE!; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/favicon.svg") return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>', { headers: { "content-type": "image/svg+xml" } });
  return new Response(`<!doctype html><title>History ${url.pathname.slice(1) || "Alpha"}</title><link rel="icon" href="/favicon.svg"><h1>History fixture</h1>${url.pathname === "/" ? '<iframe src="/frame"></iframe>' : ""}<a href="/Beta">Next</a>`, { headers: { "content-type": "text/html" } });
} });
let app: Awaited<ReturnType<typeof browserAgentApp>> | undefined;
type Page = { items: Array<{ id: number; url: string; title: string; favicon: string; tabKind: string; conversationId?: string; butlerDriven: boolean; transition: string }> };
try {
  app = await browserAgentApp(evidence, () => null);
  const a = app;
  const rows = () => a.gateway.api<Page>("/browser-history");
  // Row actions take the time column on hover; move the real pointer there first.
  const hoverRow = async (index: number) => {
    const point = await a.page.expression<{ x: number; y: number }>(`(()=>{const box=document.querySelectorAll('[data-row-id]')[${index}].getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2}})()`);
    await a.page.movePointer(point.x, point.y);
  };
  const fill = (selector: string, value: string) => a.page.expression(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const ready = async (title: string) => waitBrowser(() => a.main(`globalThis.browserAgentSubject.tabs.get(globalThis.browserAgentSubject.activeId)?.title===${JSON.stringify(title)}`), title);
  await a.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light" }) });
  await a.page.reload(); await shellReady(a, "en"); await a.call("open");
  await a.click("Browser");
  const tab = await a.call<string>("create", { url: fixture.url.href }); await ready("History Alpha");
  await waitBrowser(async () => (await rows()).items.length === 1, "one top-level visit, iframe excluded");
  await waitBrowser(async () => (await rows()).items[0]?.favicon === new URL("favicon.svg", fixture.url).href, "committed visit metadata completed");
  assert.equal((await rows()).items[0]!.favicon, new URL("favicon.svg", fixture.url).href);
  await a.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript("history.pushState({},'', '/SPA')")`);
  await waitBrowser(async () => (await rows()).items.length === 2, "same-document navigation recorded");
  assert.equal((await rows()).items[0]!.transition, "same_document");
  await a.call("navigate", { id: tab, value: new URL("Beta", fixture.url).href }); await ready("History Beta");
  await waitBrowser(async () => (await rows()).items.length === 3, "typed navigation recorded");
  assert.equal((await rows()).items[0]!.transition, "typed");
  await a.main("globalThis.browserAgentSubject.privateMode=true");
  await a.call("navigate", { id: tab, value: new URL("Private", fixture.url).href }); await ready("History Private");
  await a.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).flushHistory()`);
  assert.equal((await rows()).items.length, 3, "private hook suppresses visits");
  await a.main("globalThis.browserAgentSubject.privateMode=false");
  const conversation = await a.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: new URL("Conversation", fixture.url).href });
  await ready("History Conversation"); await waitBrowser(async () => (await rows()).items.length === 4, "conversation visit recorded");
  assert.equal((await rows()).items[0]!.conversationId, "general");
  // A stub-driven native navigation carries the same holder/use facts as the executor.
  await a.main(`(()=>{const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(conversation)});t.holder='agent';t.busy=true;return t.view.webContents.loadURL(${JSON.stringify(new URL("Driven", fixture.url).href)}).finally(()=>{t.busy=false;b.publish()})})()`);
  await ready("History Driven"); await waitBrowser(async () => (await rows()).items.length === 5, "Butler-driven visit recorded");
  assert.equal((await rows()).items[0]!.butlerDriven, true);
  await a.call("activate", { id: tab });
  // The existing browser menu is the public history entry.
  await a.click("More"); await a.page.clickText("History", "[role=menuitem]");
  await waitBrowser(() => a.page.expression("document.querySelectorAll('[data-row-id]').length===5"), "history page loaded");
  await a.page.clickSelector('[role=switch][aria-label="Visited by Butler"]');
  await waitBrowser(() => a.page.expression("document.querySelectorAll('[data-row-id]').length===1"), "Butler filter applied");
  await a.page.clickSelector('[role=switch][aria-label="Visited by Butler"]');
  await waitBrowser(() => a.page.expression("document.querySelectorAll('[data-row-id]').length===5"), "all visits restored");
  assert.equal(await a.page.expression("document.querySelectorAll('[data-row-id] [role=checkbox]').length"), 0, "check boxes only in selection mode");
  await a.page.clickText("Select", "button");
  await a.page.clickSelector("[data-row-id] [role=checkbox]");
  const lastId = (await rows()).items.at(-1)!.id;
  await a.page.clickSelector(`[data-row-id="${lastId}"] [role=checkbox]`);
  assert.equal(await a.page.expression("document.querySelectorAll('[data-row-id] [role=checkbox][aria-checked=true]').length"), 2);
  await a.page.clickText("Delete", "button");
  await waitBrowser(async () => (await rows()).items.length === 3, "multi-selected deletion committed");
  await a.call("navigate", { id: tab, value: fixture.url.href }); await ready("History Alpha");
  await waitBrowser(async () => (await rows()).items.length === 4, "a new visit to a deleted URL is recorded");
  await a.gateway.api("/library", { method: "POST", body: JSON.stringify({ id: "bookmark", kind: "bookmark", title: "History bookmarked", url: "https://example.com/bookmark", capturedAt: new Date().toISOString() }) });
  for (const language of ["ko", "en"]) for (const theme of ["light", "dark"]) {
    const ko = language === "ko";
    await a.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
    await a.main(`${a.win}.setContentSize(1440,900)`); await a.page.reload(); await shellReady(a, language);
    await a.main("globalThis.browserAgentSubject.shortcut({type:'keyDown',meta:true,key:'y'})");
    await waitBrowser(() => a.page.expression("document.querySelectorAll('[data-row-id]').length===4"), "history shortcut from App chrome");
    await a.shot(`${language}-${theme}-1440-history`);
    await hoverRow(1); await a.shot(`${language}-${theme}-1440-history-hover`, true);
    await a.page.clickText(ko ? "선택" : "Select", "button"); await a.page.clickSelector("[data-row-id] [role=checkbox]");
    await a.shot(`${language}-${theme}-1440-history-select`);
    await a.page.clickText(ko ? "취소" : "Cancel", "button");
    await a.page.clickText(ko ? "방문 기록 지우기" : "Clear browsing history", "button");
    await a.shot(`${language}-${theme}-1440-clear-dialog`); await a.page.press("Escape");
    const back = ko ? "브라우저로 돌아가기" : "Back to Browser";
    // Titlebar uses the same drawer back action; its accessible label includes Browser.
    await a.page.clickSelector("[data-test-class=\"titlebar-back\"]");
    await waitBrowser(() => a.page.expression("Boolean(document.querySelector('[data-slot=browser-pane]'))"), back);
    await a.call("activate", { id: tab });
    await a.main("globalThis.browserAgentSubject.shortcut({type:'keyDown',meta:true,key:'l'},true)");
    await fill(`[aria-label="${ko ? "주소" : "Address"}"]`, "History");
    await waitBrowser(() => a.page.expression("document.querySelectorAll('#address-suggestions [role=option]').length>=3"), "history and bookmark suggestions");
    await a.page.press("ArrowDown"); assert.equal(await a.page.expression("document.querySelector('#address-suggestion-0').getAttribute('aria-selected')"), "true");
    await a.shot(`${language}-${theme}-1440-suggestions`, true); await a.page.press("Escape");
    await a.main(`${a.win}.webContents.loadURL('app://butler/?settings=browser')`);
    await waitBrowser(() => a.page.expression("Boolean(document.querySelector('[data-settings-section-id=browser-history]'))"), "Settings history entry");
    await a.shot(`${language}-${theme}-1440-settings`);
    await a.page.clickText(ko ? "보기" : "View", "[data-settings-section-id=browser-history] button");
    await waitBrowser(() => a.page.expression("Boolean(document.querySelector('[data-test-class=history-page]'))"), "Settings opens history");
    await a.page.clickSelector('[data-test-class="titlebar-back"]');
    await waitBrowser(() => a.page.expression("Boolean(document.querySelector('[data-settings-section-id=browser-history]'))"), "History back returns to Settings");
    await a.page.clickText(ko ? "지우기" : "Clear", "[data-settings-section-id=browser-history] button");
    await waitBrowser(() => a.page.expression("Boolean(document.querySelector('[role=dialog]'))"), "Settings clear dialog");
    await a.page.press("Escape");
    await a.main(`${a.win}.webContents.loadURL('app://butler/')`); await shellReady(a, language); await a.call("open"); await a.click(ko ? "브라우저" : "Browser");
  }
  // Shift+Delete removes both a bookmark suggestion and its visit data.
  await a.main("globalThis.browserAgentSubject.shortcut({type:'keyDown',meta:true,key:'l'},true)");
  await fill('[aria-label="Address"]', "bookmarked");
  await waitBrowser(() => a.page.expression("document.querySelectorAll('#address-suggestions [role=option]').length===1"), "bookmark suggestion");
  await a.page.press("ArrowDown"); await a.page.press("Shift+Delete");
  await waitBrowser(async () => !(await a.gateway.api<{ items: unknown[] }>("/library?kind=bookmark")).items.length, "Shift+Delete removes suggestion");
  await a.main("globalThis.browserAgentSubject.shortcut({type:'keyDown',meta:true,key:'l'},true)");
  await fill('[aria-label="Address"]', "127.0.0.1");
  await waitBrowser(() => a.page.expression("document.querySelectorAll('#address-suggestions [role=option]').length>0"), "history keyboard destination");
  const chosen = (await a.gateway.api<{ items: Array<{ url: string }> }>("/browser-history/suggestions?q=127.0.0.1")).items[0]!.url;
  await a.page.press("ArrowDown"); await a.page.press("Enter");
  await waitBrowser(() => a.main(`globalThis.browserAgentSubject.tabs.get(globalThis.browserAgentSubject.activeId)?.url===${JSON.stringify(chosen)}`), "Enter navigates to selected history suggestion");
  await a.main("globalThis.browserAgentSubject.shortcut({type:'keyDown',meta:true,key:'y'})");
  await waitBrowser(() => a.page.expression("Boolean(document.querySelector('[data-row-id]'))"), "history reopened");
  const prior = (await rows()).items.length;
  await hoverRow(0); await a.page.clickSelector('[data-row-id] button[aria-label^="Delete:"]');
  await waitBrowser(async () => (await rows()).items.length === prior - 1, "single-row delete committed");
  const tabsBefore = await a.main<number>("globalThis.browserAgentSubject.tabs.size");
  await a.page.clickSelector('[data-row-id] [role=button][aria-label^="History Beta,"]');
  await waitBrowser(() => a.main(`globalThis.browserAgentSubject.tabs.size===${tabsBefore + 1}`), "history opens a new tab");
  await a.main("globalThis.browserAgentSubject.shortcut({type:'keyDown',meta:true,key:'y'})");
  await waitBrowser(() => a.page.expression("Boolean(document.querySelector('[data-test-class=history-page]'))"), "history ready for clear");
  await a.page.clickText("Clear browsing history", "button");
  await a.page.expression("(()=>{const s=document.querySelector('[role=dialog] select');s.value='all';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await a.page.clickText("Delete", "[role=dialog] button");
  await waitBrowser(async () => !(await rows()).items.length, "clear dialog removes all visits");
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, visits: 6, excludedIframe: true, privateMode: true, selectedDelete: true, keyboardEnter: true, singleDelete: true, openInTab: true, clearDialog: true, screenshots: 16 }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), main: app?.lastMain(), diagnostics: await app?.page.diagnostics().catch(() => null) }));
  await app?.shot("failure").catch(() => {}); throw error;
} finally { await app?.stop(); fixture.stop(true); }
