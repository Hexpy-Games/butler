// test-category: race
/** Real App link ingress and both native menus; external opens are stubbed. */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { shellReady } from "../support/browser-shell-acceptance";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE!;
assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
  return new Response('<!doctype html><title>Links fixture</title><a id="plain" href="/next">Next</a><a id="blank" href="/blank" target="_blank">Blank</a><button id="popup" onclick="window.open(\'/popup\',\'auth\',\'width=420,height=300\')">Popup</button><form method="post" action="/post"><input name="intent" value="fixture"><button id="submit">Submit</button></form><button id="simple" onclick="window.open(\'/simple\')">Simple popup</button>', { headers: { "content-type": "text/html" } });
} });
let app: Awaited<ReturnType<typeof browserAgentApp>> | undefined;
type State = { activeId: string; tabs: Array<{ id: string; owner: string; url: string }> };
const facts: unknown[] = [];
const captureErrors: string[] = [];
try {
  app = await browserAgentApp(evidence, () => null, undefined, { config: { language: "ko" }, stubReply: () => `[테스트 링크](${fixture.url.href})` });
  const a = app;
  const module = `process.getBuiltinModule('module').createRequire(${JSON.stringify(resolve("packages/butler-app/client/electron/package.json"))})`;
  const electron = `${module}('electron')`;
  await shellReady(a, "ko");
  await a.main(`(()=>{const e=${electron};globalThis.externalLinks=[];e.shell.openExternal=async url=>{globalThis.externalLinks.push(url)};globalThis.linkMenus=[];
    const build=e.Menu.buildFromTemplate;e.Menu.buildFromTemplate=function(items){const menu=build.call(this,items);globalThis.linkMenus.push(menu);return menu};})()`);
  const name = await a.main<string>(`${module}(${JSON.stringify(resolve("packages/butler-app/client/electron/butler-platform/default-browser.mjs"))}).defaultBrowserName('ko')`);
  const label = `다음 브라우저로 열기: ${name}`;
  const state = () => a.call<State>("state");
  await a.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text: "링크를 보여 주세요", client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => (await a.gateway.api<any>("/session-view?session_id=general")).latest_turn?.state === "delivered", "stub chat reply");
  await a.click("일반");
  await a.page.waitForFunction(() => Boolean(document.querySelector("a[href]")?.textContent));
  const chatLink = `a[href="${fixture.url.href}"]`;
  await waitBrowser(() => a.page.expression(`Boolean(document.querySelector(${JSON.stringify(chatLink)}))`), "markdown link");
  await a.page.clickSelector(chatLink);
  await waitBrowser(async () => (await state()).tabs.some(t => t.owner === "mine" && t.url === fixture.url.href), "chat link opens my tab");
  await waitBrowser(() => a.page.expression("Boolean(document.querySelector('[data-test-class=browser-area]'))"), "Browser area shown");
  const tab = (await state()).activeId;
  const contents = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents`;
  await waitBrowser(() => a.main(`${contents}.getTitle()==='Links fixture' && !${contents}.isLoading()`), "page loaded");
  assert.deepEqual(await a.main("globalThis.externalLinks"), []);
  facts.push({ chatClick: "passed", tab, owner: "mine" });

  async function menu(context: "app" | "page", theme: "light" | "dark") {
    await a.main(`${electron}.nativeTheme.themeSource=${JSON.stringify(theme)};globalThis.linkMenus=[]`);
    await a.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
    if (context === "app") {
      await a.click("일반");
      await waitBrowser(() => a.page.expression(`Boolean(document.querySelector(${JSON.stringify(chatLink)}))`), "chat link visible");
      const point = await a.page.expression<{ x: number; y: number }>(`(()=>{const r=document.querySelector(${JSON.stringify(chatLink)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await a.main(`${a.win}.webContents.sendInputEvent({type:'mouseDown',button:'right',clickCount:1,x:${Math.round(point.x)},y:${Math.round(point.y)}});${a.win}.webContents.sendInputEvent({type:'mouseUp',button:'right',clickCount:1,x:${Math.round(point.x)},y:${Math.round(point.y)}})`);
    } else {
      await a.click("브라우저"); await a.call("activate", { id: tab });
      await nativeClick("#plain", "right");
    }
    await waitBrowser(() => a.main("globalThis.linkMenus.length>0"), "native link menu");
    const labels = await a.main<string[]>("globalThis.linkMenus.at(-1).items.map(i=>i.label)");
    assert.ok(labels.includes(label), JSON.stringify(labels));
    assert.ok(labels.includes("링크 복사"));
    const bounds = await a.main<{ x: number; y: number; width: number; height: number }>(`${a.win}.getBounds()`);
    const path = join(evidence, `ko-${theme}-${context}-menu.png`);
    if (!captureErrors.length) {
      try {
        if (process.env.BUTLER_LINK_MENU_CAPTURE_EXTERNAL === "1") {
          writeFileSync(join(evidence, "capture-request.json"), JSON.stringify({ path, context, theme, bounds }));
          await waitBrowser(async () => existsSync(path), "external native menu screenshot");
        } else await a.main(`${module}(${JSON.stringify(resolve("packages/butler-app/client/electron/butler-platform/link-menu-smoke-capture.mjs"))}).captureLinkMenu(${JSON.stringify(bounds)},${JSON.stringify(path)})`);
      } catch (error) { captureErrors.push(String(error)); }
    }
    await a.main(`(()=>{const m=globalThis.linkMenus.at(-1);m.items.find(i=>i.label===${JSON.stringify(label)}).click();m.closePopup(${a.win})})()`);
    await waitBrowser(() => a.main("globalThis.externalLinks.length>0"), "stub external path invoked");
    const opened = await a.main<string>("globalThis.externalLinks.pop()");
    assert.equal(opened, context === "app" ? fixture.url.href : new URL("/next", fixture.url).href);
    facts.push({ context, theme, labels, externalOpen: "stubbed" });
  }
  async function nativeClick(selector: string, button = "left", modifiers: string[] = []) {
    const point = await a.main<{ x: number; y: number }>(`${contents}.executeJavaScript(${JSON.stringify(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)})`);
    await a.main(`${contents}.sendInputEvent(${JSON.stringify({ type: "mouseDown", ...point, button, clickCount: 1, modifiers })});${contents}.sendInputEvent(${JSON.stringify({ type: "mouseUp", ...point, button, clickCount: 1, modifiers })})`);
  }
  for (const theme of ["light", "dark"] as const) for (const context of ["app", "page"] as const) await menu(context, theme);
  const modifier = await a.main<string>(`${module}(${JSON.stringify(resolve("packages/butler-app/client/electron/butler-platform/browser-shortcuts.mjs"))}).newTabModifier()`);
  for (const [selector, button, modifiers] of [["#blank", "left", []], ["#plain", "middle", []], ["#plain", "left", [modifier]]] as const) {
    await a.call("activate", { id: tab });
    const before = (await state()).tabs.length;
    await nativeClick(selector, button, [...modifiers]);
    await waitBrowser(async () => (await state()).tabs.length === before + 1, "page gesture opens a new tab");
    assert.equal(await a.main("[...globalThis.browserAgentSubject.tabs.values()].some(t=>t.popup)"), false);
    facts.push({ selector, button, modifiers, newTab: "passed" });
  }
  await a.call("activate", { id: tab }); await nativeClick("#popup");
  await waitBrowser(() => a.main("[...globalThis.browserAgentSubject.tabs.values()].some(t=>t.popupWindow)"), "JS popup preserved");
  const popup = await a.main<string>("[...globalThis.browserAgentSubject.tabs.values()].find(t=>t.popupWindow).id");
  await waitBrowser(() => a.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(popup)}).view.webContents.getTitle()==='Links fixture'`), "popup loaded");
  assert.equal(await a.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(popup)}).view.webContents.executeJavaScript('Boolean(opener)')`), true);
  facts.push({ jsPopup: "opener preserved" });
  await a.call("close", { id: popup });
  await waitBrowser(() => a.main("![...globalThis.browserAgentSubject.tabs.values()].some(t=>t.popupWindow)"), "first popup closed");
  await a.call("activate", { id: tab }); await nativeClick("#simple");
  await waitBrowser(() => a.main("[...globalThis.browserAgentSubject.tabs.values()].some(t=>t.popupWindow)"), "featureless JS popup preserved");
  const simple = await a.main<string>("[...globalThis.browserAgentSubject.tabs.values()].find(t=>t.popupWindow).id");
  await waitBrowser(() => a.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(simple)}).view.webContents.getTitle()==='Links fixture'`), "featureless popup loaded");
  assert.equal(await a.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(simple)}).view.webContents.executeJavaScript('Boolean(opener)')`), true);
  facts.push({ featurelessJsPopup: "opener preserved" });
  await a.call("close", { id: simple });
  await waitBrowser(() => a.main("![...globalThis.browserAgentSubject.tabs.values()].some(t=>t.popupWindow)"), "featureless popup closed");
  const before = (await state()).tabs.length;
  const frameUrl = new URL("/__links_fixture__", a.gateway.url).href;
  const frameHtml = `<a id="plain" href="${new URL("/next", fixture.url).href}">Preview link</a><form method="post" action="/__links_fixture__/post"><input name="intent" value="fixture"><button id="submit">Submit</button></form>`;
  await a.main(`(()=>{globalThis.framePosts=[];return ${a.win}.webContents.session.protocol.handle('http',async request=>{if(!new URL(request.url).pathname.startsWith('/__links_fixture__'))return ${electron}.net.fetch(request,{bypassCustomProtocolHandlers:true});if(request.method==='POST')globalThis.framePosts.push(await request.text());return new Response(${JSON.stringify(frameHtml)},{headers:{'content-type':'text/html'}})})})()`);
  await a.click("일반");
  await a.page.expression(`(()=>{const frame=document.createElement('iframe');frame.id='link-preview';frame.src=${JSON.stringify(frameUrl)};document.body.append(frame)})()`);
  await waitBrowser(() => a.main(`${a.win}.webContents.mainFrame.frames.some(f=>f.url===${JSON.stringify(frameUrl)})`), "preview frame loaded");
  await a.main(`${a.win}.webContents.mainFrame.frames.find(f=>f.url===${JSON.stringify(frameUrl)}).executeJavaScript("document.querySelector('#plain').click()")`);
  await waitBrowser(async () => (await state()).tabs.length === before + 1, "preview link opens my tab");
  facts.push({ previewLink: "passed" });
  const formBefore = (await state()).tabs.length;
  await a.main(`${a.win}.webContents.mainFrame.frames.find(f=>f.url===${JSON.stringify(frameUrl)}).executeJavaScript("document.querySelector('#submit').click()")`);
  await waitBrowser(() => a.main("globalThis.framePosts.length===1"), "preview form POST preserved");
  assert.deepEqual(await a.main("globalThis.framePosts"), ["intent=fixture"]);
  assert.equal((await state()).tabs.length, formBefore);
  facts.push({ previewForm: "POST preserved" });
  const windowBefore = (await state()).tabs.length;
  await a.page.expression(`window.open(${JSON.stringify(fixture.url.href)},'_blank')`);
  await waitBrowser(async () => (await state()).tabs.length === windowBefore + 1, "App window.open routed");
  await a.page.expression("window.open('mailto:fixture@example.invalid','_blank')");
  await waitBrowser(() => a.main("globalThis.externalLinks.includes('mailto:fixture@example.invalid')"), "non-web scheme preserved");
  facts.push({ appWindowOpen: "passed", mailto: "existing external handler" });
  writeFileSync(join(evidence, "acceptance.json"), JSON.stringify({ functionalStatus: "passed", screenshotStatus: captureErrors.length ? "unavailable" : "passed", captureErrors, name, facts, liveModelCalls: 0 }, null, 2));
  assert.equal(captureErrors.length, 0, "Native menu screenshot acceptance is required");
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), facts, lastMain: app?.lastMain(), frames: await app?.main(`${app.win}.webContents.mainFrame.framesInSubtree.map(f=>({url:f.url,name:f.name}))`).catch(()=>null) }, null, 2));
  throw error;
} finally { fixture.stop(true); await app?.stop(); }
