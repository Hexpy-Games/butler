import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
/** S1 acceptance through the real App shell, isolated gateway and native browser. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, nativePeekDismiss, pane, sessionInfoBesideBrowser, shellGeometry, shellReady, toggle, togglePane, toggleState } from "../support/browser-shell-acceptance";
import { assertNewTabContent, newTabHub } from "../support/browser-newtab-acceptance";
import { playingVideoFixture, routeReturnKeepsPage } from "../support/browser-route-return";
import { assertSidebarRouteActive } from "../support/sidebar-route-active";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const started = Date.now();
const fixture = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(
  '<!doctype html><title>Browser shell fixture</title><style>body{margin:0;background:#fff;color:#172033;font:18px system-ui;padding:36px}button{background:#365bf5;color:white;padding:12px 24px;border:0;border-radius:8px}</style><h1>Browser shell fixture</h1><p>A complete native page inside the conversation frame.</p><button onclick="this.textContent=\'Confirmed\'">Confirm</button>',
  { headers: { "content-type": "text/html" } },
) });
const app = await browserAgentApp(evidence, () => null);
const facts: unknown[] = [];
try {
  await newTabHub(app);
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light" }) });
  const created = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Second conversation" }) });
  await app.page.reload(); await shellReady(app, "en");
  if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open') === 'false'")) await app.click("Show sidebar");
  await waitBrowser(() => app.page.expression("!document.querySelector('[data-slot=adaptive-shell-sidebar]').getAnimations().some(a=>a.playState==='running')"), "sidebar open motion settles");
  await app.click(getAppCopy("en-US").space.general);
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text: "Compare the browser fixture in this conversation.", client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { state: string } }>("/session-view?session_id=general")).latest_turn?.state === "delivered", "stub conversation delivered");
  await app.call("open");
  const first = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: fixture.url.href });
  const second = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: `${fixture.url.href}second` });
  const mine = await app.call<string>("create", { url: fixture.url.href });
  await app.call("activate", { id: first });
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
    await app.main(`${app.win}.setContentSize(${width},900)`);
    await app.page.reload(); await shellReady(app, locale);
    if (await app.page.expression(`Boolean(document.querySelector('${pane}'))`)) await togglePane(app, false);
    await toggleState(app, null, false); await app.shot(`${locale}-${theme}-${width}-toggle-off`);
    await togglePane(app, true); await nativeAligned(app); await toggleState(app, "butler", false);
    const geometry = await shellGeometry(app, width, evidence); facts.push({ locale, theme, width, geometry });
    assert.equal(await app.page.expression(`document.querySelector('${pane}').querySelectorAll('[role="tab"]').length`), 2);
    await app.shot(`${locale}-${theme}-${width}-conversation-corners`);
    if (width === 1100) {
      facts.push({ locale, theme, width, peek: await nativePeekDismiss(app, `${locale}-${theme}-${width}`, evidence) });
    }
    await app.main(`(()=>{const b=globalThis.browserAgentSubject;b.tabs.get(${JSON.stringify(first)}).driven=true;b.tabs.get(${JSON.stringify(first)}).busy=true;b.publish()})()`);
    await toggleState(app, "butler", false); await app.shot(`${locale}-${theme}-${width}-toggle-busy-open`);
    await togglePane(app, false); await toggleState(app, "riso", true); await app.shot(`${locale}-${theme}-${width}-toggle-busy-closed`);
    await app.main(`(()=>{const b=globalThis.browserAgentSubject;b.tabs.get(${JSON.stringify(first)}).busy=false;b.publish()})()`);
    const general = getAppCopy(locale === "ko" ? "ko-KR" : "en-US").space.general;
    if (width === 1440) await assertSidebarRouteActive(app, "session", general);
    await app.click(locale === "ko" ? "브라우저" : "Browser");
    await app.call("activate", { id: first }); await nativeAligned(app);
    assert.equal(await app.page.expression("Boolean(document.querySelector('[data-slot=adaptive-shell-split-chat]'))"), false);
    assert.equal(await app.page.expression("Boolean(document.querySelector('[data-slot=adaptive-shell-inspector][data-open=true]'))"), false);
    await app.shot(`${locale}-${theme}-${width}-hub-corners`);
    if (width === 1440) {
      await assertSidebarRouteActive(app, "browser", locale === "ko" ? "브라우저" : "Browser");
      await app.shot(`${locale}-${theme}-1440-sidebar-browser-active`);
    }
    await app.page.clickSelector('[data-slot="titlebar-leading"] button');
    await waitBrowser(() => app.page.expression(`document.querySelector('${toggle}')?.getAttribute('aria-pressed') === 'true'`), "hub conversation entry");
    if (width === 1440) await assertSidebarRouteActive(app, "session", general);
  }
  await app.main(`${app.win}.setContentSize(1440,900)`);
  await nativeAligned(app);
  await app.main(`${app.win}.webContents.focus()`);
  await app.page.clickSelector('[role="separator"][aria-label="Resize conversation"]');
  await waitBrowser(() => app.page.expression("document.activeElement?.getAttribute('role') === 'separator'"), "chat resize handle focused");
  await app.page.press("End");
  await waitBrowser(() => app.page.expression("document.querySelector('[data-slot=adaptive-shell-split-chat]').getBoundingClientRect().width === 560"), "chat maximum width");
  assert.equal(await app.page.expression("document.querySelector('[data-slot=adaptive-shell-split-chat]').getBoundingClientRect().width"), 560);
  await app.page.press("Home");
  await waitBrowser(() => app.page.expression("document.querySelector('[data-slot=adaptive-shell-split-chat]').getBoundingClientRect().width === 340"), "chat minimum width");
  assert.equal(await app.page.expression("document.querySelector('[data-slot=adaptive-shell-split-chat]').getBoundingClientRect().width"), 340);
  await app.page.press("ArrowRight"); await nativeAligned(app);
  await app.call("activate", { id: second }); await nativeAligned(app);
  await togglePane(app, false); await togglePane(app, true);
  assert.equal((await app.call<{ activeId: string }>("state")).activeId, second);
  await app.click("Second conversation");
  await assertSidebarRouteActive(app, "session", "Second conversation");
  await waitBrowser(() => app.page.expression(`!document.querySelector('${pane}') && document.querySelector('[data-test-class=custom-titlebar]')?.textContent.includes('Second conversation')`), "second conversation has its own closed browser pane");
  assert.equal(await app.page.expression(`Boolean(document.querySelector('${pane}'))`), false);
  await togglePane(app, true);
  // A conversation pane opened with no tabs opens one new tab at once (no empty state, no New tab click).
  const ownTabs = async () => (await app.call<{ tabs: Array<{ id: string; owner: string }> }>("state")).tabs.filter((tab) => tab.owner === `conversation:${created.session.id}`);
  await waitBrowser(async () => (await ownTabs()).length === 1 && (await app.call<{ activeId: string }>("state")).activeId === (await ownTabs())[0]?.id, "second conversation opens its own tab");
  const other = (await app.call<{ activeId: string }>("state")).activeId;
  assert.notEqual(other, second);
  assert.equal((await ownTabs()).length, 1);
  await waitBrowser(() => app.page.expression("document.activeElement?.closest('[data-slot=address-field]') !== null"), "conversation new-tab address focus");
  await assertNewTabContent(app.page, "en");
  await app.click(getAppCopy("en-US").space.general); await nativeAligned(app);
  assert.equal((await app.call<{ activeId: string }>("state")).activeId, second);
  // A playing page stays on screen, with its favicon, through session and Settings round trips and a reload.
  const video = playingVideoFixture();
  try {
    const playing = await app.call<string>("create", { owner: "conversation:general", url: video.url.href });
    await app.call("activate", { id: playing }); await nativeAligned(app);
    await waitBrowser(() => app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(playing)}).view.webContents.executeJavaScript("!document.querySelector('video').paused")`), "fixture video plays");
    // Precondition: playing media turns throttling off, so the page stays visible while detached.
    await waitBrowser(() => app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(playing)}).view.webContents.getBackgroundThrottling() === false`), "playing page runs unthrottled");
    await routeReturnKeepsPage(app, playing, new URL("/icon.png", video.url).href, "Second conversation");
    await app.shot("en-light-1440-route-return");
    // A page that reports no icon (an error page) does not keep the previous page's favicon.
    await app.call("navigate", { id: playing, value: "http://127.0.0.1:1/" });
    await waitBrowser(async () => (await app.call<{ tabs: Array<{ id: string; status: string; favicon: string }> }>("state")).tabs
      .some((tab) => tab.id === playing && tab.status === "idle" && tab.favicon === ""), "error page drops the previous favicon");
    await app.call("close", { id: playing });
  } finally { video.stop(true); }
  await app.call("activate", { id: second }); await nativeAligned(app);
  await sessionInfoBesideBrowser(app);
  await app.click("Browser"); await app.call("activate", { id: mine });
  await app.click("Move to a conversation");
  await waitBrowser(() => app.page.expression("[...document.querySelectorAll('[role=menuitem]')].some(n=>n.textContent?.trim()==='Second conversation')"), "conversation move menu");
  await app.page.clickText("Second conversation", '[role="menuitem"]');
  await waitBrowser(async () => (await app.call<{ tabs: Array<{ id: string; owner: string }> }>("state")).tabs.find((tab) => tab.id === mine)?.owner === `conversation:${created.session.id}`, "hub my-tab entry");
  await app.click("Library");
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="library-page"]')));
  assert.equal(await app.page.expression(`Boolean(document.querySelector('${pane}'))`), false);
  await assertSidebarRouteActive(app, "library", "Library");
  await app.shot("en-dark-library");
  await app.click("Browser");
  await assertSidebarRouteActive(app, "browser", "Browser");
  await app.click("Second conversation");
  await assertSidebarRouteActive(app, "session", "Second conversation");
  // #1188: the window shrinks to its minimum, and the Browser's tab strip and toolbar still fit there.
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
    await app.main(`${app.win}.setContentSize(1440,900)`);
    await app.page.reload(); await shellReady(app, locale);
    // The compact window closed the sidebar; reopen it to reach the Browser entry.
    if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open') === 'false'")) {
      await app.click(getAppCopy(locale === "ko" ? "ko-KR" : "en-US").titlebar.showLeftPanel);
    }
    await app.click(locale === "ko" ? "브라우저" : "Browser"); await app.call("activate", { id: first });
    await waitBrowser(() => app.page.expression(`Boolean(document.querySelector('${pane}'))`), "Browser hub pane");
    await app.main(`${app.win}.setSize(1,1)`);
    await waitBrowser(() => app.page.expression("innerWidth === 344 && innerHeight === 480"), "window at its minimum size");
    assert.deepEqual(await app.main(`${app.win}.getMinimumSize()`), [344, 480]);
    await nativeAligned(app);
    // 266487a220: overflow tabs scroll sideways once their minimum widths no longer fit.
    const clipped = await app.page.expression<string[]>(`[...document.querySelectorAll('${pane} [data-slot=browser-toolbar] :is(button,input), ${pane} [role=tab]')]
      .filter(n => n.getBoundingClientRect().width > 0).flatMap(n => { n.scrollIntoView({block:"nearest",inline:"center",behavior:"instant"}); const r = n.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && n.contains(hit) ? [] : [n.getAttribute('aria-label') || n.textContent]; })`);
    assert.deepEqual(clipped, [], "Browser tabs and toolbar remain reachable at the minimum window");
    await app.shot(`${locale}-${theme}-minimum-hub`);
  }
  writeFileSync(join(evidence, "shell-result.json"), JSON.stringify({ ok: true, elapsedMs: Date.now() - started, facts }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "shell-failure.json"), JSON.stringify({ error: String(error), dom: await app.page.expression("({text:document.body.innerText,lang:document.documentElement.lang})").catch(() => null) }));
  await app.shot("failure").catch(() => {}); throw error;
} finally { fixture.stop(true); await app.stop(); }
