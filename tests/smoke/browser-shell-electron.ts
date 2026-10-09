/** S1 acceptance through the real App shell, isolated gateway and native browser. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, pane, shellGeometry, shellReady, toggle, togglePane, toggleState } from "../support/browser-shell-acceptance";

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
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light" }) });
  const created = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Second conversation" }) });
  await app.page.reload(); await shellReady(app, "en");
  await app.page.clickText("General", '[data-test-class="app-sidebar"] *');
  await app.call("open");
  const first = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: fixture.url.href });
  const second = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: `${fixture.url.href}second` });
  const mine = await app.call<string>("create", { url: fixture.url.href });
  await app.call("activate", { id: first });
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
    await app.main(`${app.win}.setContentSize(${width},900)`);
    await app.page.reload(); await shellReady(app, locale);
    await app.page.clickText(locale === "ko" ? "일반" : "General", '[data-test-class="app-sidebar"] *');
    if (await app.page.expression(`Boolean(document.querySelector('${pane}'))`)) await togglePane(app, false);
    await toggleState(app, null, false); await app.shot(`${locale}-${theme}-${width}-toggle-off`);
    await togglePane(app, true); await nativeAligned(app); await toggleState(app, "butler", false);
    const geometry = await shellGeometry(app, width, evidence); facts.push({ locale, theme, width, geometry });
    assert.equal(await app.page.expression(`document.querySelector('${pane}').querySelectorAll('[role="tab"]').length`), 2);
    await app.shot(`${locale}-${theme}-${width}-conversation-corners`);
    if (width === 1100) {
      await app.page.movePointer(2, 400);
      await waitBrowser(() => app.page.expression("document.querySelector('[data-left-peek=\"true\"]') !== null"), "left-edge sidebar peek");
      await app.shot(`${locale}-${theme}-${width}-peek`);
      await app.page.movePointer(600, 400);
      await waitBrowser(() => app.page.expression("document.querySelector('[data-left-peek=\"true\"]') === null"), "peek dismisses");
    }
    await app.main(`(()=>{const b=globalThis.browserAgentSubject;b.tabs.get(${JSON.stringify(first)}).busy=true;b.publish()})()`);
    await toggleState(app, "riso", false); await app.shot(`${locale}-${theme}-${width}-toggle-busy-open`);
    await togglePane(app, false); await toggleState(app, "riso", true); await app.shot(`${locale}-${theme}-${width}-toggle-busy-closed`);
    await app.main(`(()=>{const b=globalThis.browserAgentSubject;b.tabs.get(${JSON.stringify(first)}).busy=false;b.publish()})()`);
    await app.click(locale === "ko" ? "브라우저" : "Browser");
    await app.call("activate", { id: first }); await nativeAligned(app);
    assert.equal(await app.page.expression("Boolean(document.querySelector('[data-slot=adaptive-shell-split-chat]'))"), false);
    assert.equal(await app.page.expression("Boolean(document.querySelector('[data-slot=adaptive-shell-inspector][data-open=true]'))"), false);
    await app.shot(`${locale}-${theme}-${width}-hub-corners`);
    await app.page.clickSelector('[data-slot="titlebar-leading"] button');
    await waitBrowser(() => app.page.expression(`document.querySelector('${toggle}')?.getAttribute('aria-pressed') === 'true'`), "hub conversation entry");
  }
  await app.main(`${app.win}.setContentSize(1440,900)`);
  await app.page.clickSelector('[role="separator"][aria-label="Resize conversation"]');
  await app.page.press("End");
  assert.equal(await app.page.expression("document.querySelector('[data-slot=adaptive-shell-split-chat]').getBoundingClientRect().width"), 560);
  await app.page.press("Home");
  assert.equal(await app.page.expression("document.querySelector('[data-slot=adaptive-shell-split-chat]').getBoundingClientRect().width"), 340);
  await app.page.press("ArrowRight"); await nativeAligned(app);
  await app.call("activate", { id: second }); await nativeAligned(app);
  await togglePane(app, false); await togglePane(app, true);
  assert.equal((await app.call<{ activeId: string }>("state")).activeId, second);
  await app.page.clickText("Second conversation", '[data-test-class="app-sidebar"] *');
  assert.equal(await app.page.expression(`Boolean(document.querySelector('${pane}'))`), false);
  await togglePane(app, true);
  const other = (await app.call<{ activeId: string }>("state")).activeId;
  assert.notEqual(other, second);
  await app.page.clickText("General", '[data-test-class="app-sidebar"] *'); await nativeAligned(app);
  assert.equal((await app.call<{ activeId: string }>("state")).activeId, second);
  await app.click("Show right panel");
  await waitBrowser(() => app.page.expression(`!document.querySelector('${pane}')`), "inspector closes browser");
  await togglePane(app, true);
  assert.equal(await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-right-open')"), "false");
  await app.click("Browser"); await app.call("activate", { id: mine });
  await app.click("Move to a conversation"); await app.click("Second conversation");
  await waitBrowser(async () => (await app.call<{ tabs: Array<{ id: string; owner: string }> }>("state")).tabs.find((tab) => tab.id === mine)?.owner === `conversation:${created.session.id}`, "hub my-tab entry");
  await app.click("Library");
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="library-page"]')));
  assert.equal(await app.page.expression(`Boolean(document.querySelector('${pane}'))`), false);
  await app.shot("en-dark-library");
  writeFileSync(join(evidence, "shell-result.json"), JSON.stringify({ ok: true, elapsedMs: Date.now() - started, facts }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "shell-failure.json"), JSON.stringify({ error: String(error), dom: await app.page.expression("({text:document.body.innerText,lang:document.documentElement.lang})").catch(() => null) }));
  await app.shot("failure").catch(() => {}); throw error;
} finally { fixture.stop(true); await app.stop(); }
