// test-category: race
/** Offline real App: production rail, live IPC, focus/close, decisions, and visual matrix. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { actConfirm, describeBrowser, bridgeBrowser } from "../support/browser-agent-stub";
import { shellReady, togglePane } from "../support/browser-shell-acceptance";

const root = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(root);
const baseline = process.env.BUTLER_RAIL_BASELINE === "1";
const evidence = join(root, baseline ? "before" : "after"); mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
const browser = "globalThis.browserAgentSubject";
const rail = '[data-slot="tab-rail"]';
const media = '[data-slot="composer-decision-media"]';
let captures = 0;
const shot = async (name: string) => {
  await app.page.movePointer(0, 0);
  await app.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  writeFileSync(join(evidence, `${name}.png`), await app.page.screenshot()); captures++;
};
async function clickVisible(selector: string) {
  await waitBrowser(() => app.page.expression(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)return false;const r=node.getBoundingClientRect();return r.width>0&&r.height>0&&node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`), "target is hit-testable after motion");
  await app.page.clickSelector(selector);
}
async function settleSidebar() {
  await app.page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await waitBrowser(() => app.page.expression("!document.querySelector('[data-slot=adaptive-shell-sidebar]')?.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect?.getComputedTiming().iterations!==Infinity)"), "sidebar navigation motion settled");
}
async function matrix(screen: string) {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) for (const wallpaper of [false, true]) {
    console.log(screen, theme, width, wallpaper);
    const source = wallpaper ? { kind: "live", module: "butler.riso-print" } : { kind: "none" };
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
      reduce_motion: screen === "new-chat", wallpaper: { source, motion: "paused", pauseOnBattery: true }, conversation_background: { source, overlay: 0 } }) });
    await app.main(`${app.win}.setContentSize(${width},900)`);
    await app.page.reload(); await shellReady(app, "ko");
    if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open')==='false'")) await app.click("사이드바 보기");
    await app.page.clickText(screen === "new-chat" ? "Empty capture" : "일반", "[data-test-class=app-sidebar] button,[data-test-class=app-sidebar] [role=button]");
    await settleSidebar();
    const inspector = "[data-test-class=titlebar-right-panel-toggle]";
    if (await app.page.expression(`document.querySelector('${inspector}')?.getAttribute('aria-pressed')==='true'`)) await app.page.clickSelector(inspector);
    if (width === 390 && await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open')==='true'")) await app.click("사이드바 숨기기");
    await settleSidebar();
    await waitBrowser(() => app.page.expression(screen === "new-chat" ? "Boolean(document.querySelector('[data-test-class=new-chat-empty-state]'))" : "document.querySelector('[data-test-class=custom-titlebar]').textContent.includes('일반')"), "expected conversation visible");
    if (!baseline && screen === "rail") await waitBrowser(() => app.page.expression(`document.querySelectorAll('${rail} [data-slot=live-tab-canvas]').length === 3`), "matrix frames");
    if (!baseline && screen === "approval") await waitBrowser(() => app.page.expression(`Boolean(document.querySelector('${media} [data-slot=live-tab-canvas]'))`), "matrix approval frame");
    assert.equal(await app.page.expression("document.documentElement.scrollWidth > innerWidth"), false, "no horizontal overflow");
    await shot(`${screen}-${theme}-${width}-${wallpaper ? "wallpaper" : "plain"}`);
  }
}
try {
  await app.call("state");
  const ids: string[] = [];
  for (let index = 0; index < 4; index++) {
    const result = await app.main<{ tab: string; status: string }>(`${browser}.execute(${JSON.stringify({ op: "tab.open", session: "general", args: { url: app.url, background: true, policy: { content_origin: new URL(app.url).origin } } })})`);
    assert.equal(result.status, "ok"); ids.push(result.tab);
  }
  await app.main(`(()=>{for(const [n,id] of ${JSON.stringify(ids)}.entries()){const tab=${browser}.tabs.get(id);tab.title='Page '+(n+1);tab.busy=true;tab.lastAgentCall=4-n;} ${browser}.publish()})()`);
  await app.click("General");
  assert.equal(await app.page.expression("Boolean(document.querySelector('[data-slot=browser-pane]'))"), false, "no automatic area open");
  if (!baseline) {
    await waitBrowser(() => app.page.expression(`document.querySelectorAll('${rail} [data-slot=live-tab-canvas]').length===3`), "three parallel frames");
    assert.equal(await app.main(`${browser}.live.subscriptions.size`), 3, "hidden fourth tab has no stream");
    await app.main(`${app.win}.setContentSize(1440,540)`);
    await waitBrowser(() => app.page.expression(`document.querySelectorAll('${rail} [data-slot=live-tab-canvas]').length===2`), "short card shows two frames");
    assert.equal(await app.main(`${browser}.live.subscriptions.size`), 2);
    await app.main(`${app.win}.setContentSize(1440,900)`);
    await waitBrowser(() => app.page.expression(`document.querySelectorAll('${rail} [data-slot=live-tab-canvas]').length===3`), "tall card shows three frames");
    await app.page.clickSelector(`${rail} button[aria-label="1 more tab · View in browser"]`);
    await waitBrowser(() => app.main(`${browser}.activeId===${JSON.stringify(ids[3])}`), "more focuses first hidden tab");
    await togglePane(app, false);
    await waitBrowser(() => app.page.expression(`document.querySelectorAll('${rail} [data-slot=live-tab-canvas]').length===3`), "rail returns after more");
    await app.page.clickSelector(`${rail} [role="button"][aria-label="Page 2 · Butler is browsing"]`);
    await waitBrowser(() => app.main(`${browser}.activeId===${JSON.stringify(ids[1])}`), "card focuses its exact tab");
    await waitBrowser(() => app.page.expression(`!document.querySelector('${rail}')`), "rail hidden with area");
    await waitBrowser(() => app.main(`${browser}.live.subscriptions.size===0`), "hidden rail unsubscribes");
    await togglePane(app, false);
    await waitBrowser(() => app.page.expression(`document.querySelectorAll('${rail} [data-slot=live-tab-canvas]').length===3`), "rail returns");
    await app.page.clickSelector(`${rail} button[aria-label="Close tab"]`);
    await waitBrowser(() => app.main(`!${browser}.tabs.has(${JSON.stringify(ids[0])})`), "close removes the tab");
    ids.shift();
  } else { await app.call("close", { id: ids.shift() }); }
  await matrix("rail");
  // A real pending browser act from a stub turn carries its exact tab through the gateway.
  await app.main(`(()=>{for(const id of ${JSON.stringify(ids)})${browser}.tabs.get(id).busy=false;${browser}.publish()})()`);
  const tab = ids[1]!;
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "ask_first" }) });
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab }), request => {
    const call = actConfirm(request);
    const args = call.arguments.arguments as { steps: Array<{ commits?: boolean }> };
    args.steps[0]!.commits = true;
    return call;
  }]);
  await app.send("Review this browser action");
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=composer-authority-decision]'))"), "real approval");
  if (!baseline) {
    await waitBrowser(() => app.page.expression(`Boolean(document.querySelector('${media} [data-slot=live-tab-canvas]'))`), "approval has decoded thumbnail");
    const cards = await app.gateway.api<{ requests: Array<{ approval: { operation: { browser_tab: string } } }> }>("/authority-requests?session_id=general");
    assert.equal(cards.requests[0]!.approval.operation.browser_tab, tab);
  }
  await matrix("approval");
  if (!baseline) {
    await clickVisible(`${media} [role="button"]`);
    await waitBrowser(() => app.main(`${browser}.activeId===${JSON.stringify(tab)}`), "approval media opens exact tab");
    await togglePane(app, false);
  }
  const pending = await app.gateway.api<{ active_turn: { id: string } }>("/session-view?session_id=general");
  await app.gateway.api(`/turns/${pending.active_turn.id}/cancel`, { method: "POST", body: "{}" });
  await waitBrowser(async () => !(await app.gateway.api<{ active_turn?: unknown }>("/session-view?session_id=general")).active_turn, "approval turn cancelled");
  if (!baseline) {
    await app.call("control", { id: tab, holder: "user", sticky: true });
    app.stub.set([describeBrowser, () => bridgeBrowser("browser_wait_for_user", { tab, reason: "secure_field" })]);
    await app.send("Wait for the user to finish in this tab");
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=composer-browser-handoff] [data-slot=live-tab-canvas]'))"), "handoff thumbnail");
    assert.equal(await app.page.expression("Boolean(document.querySelector('[data-slot=browser-pane]'))"), false, "handoff does not auto-open");
    await shot("handoff-ko-dark-390-wallpaper");
    await app.page.clickText("열어서 확인", "[data-test-class=composer-browser-handoff] button");
    await waitBrowser(() => app.main(`${browser}.activeId===${JSON.stringify(tab)}`), "handoff opens exact tab");
    await app.call("control", { id: tab, holder: "agent" }); await app.delivered();
    await togglePane(app, false);
    await app.main(`(()=>{for(const t of ${browser}.tabs.values())t.busy=false;${browser}.tabs.get(${JSON.stringify(tab)}).status='crashed';${browser}.publish()})()`);
    await waitBrowser(() => app.page.expression("document.querySelector('[data-slot=activity-glow]')?.getAttribute('data-state')==='error'"), "error glow");
  }
  // New chat has no tabs: capture the completed onboarding screen independently.
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ reduce_motion: true }) });
  await app.gateway.api("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Empty capture" }) });
  await app.page.reload(); await shellReady(app, "ko");
  if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open')==='false'")) await app.click("사이드바 보기");
  await app.page.clickText("Empty capture", "[data-test-class=app-sidebar] button,[data-test-class=app-sidebar] [role=button]");
  await settleSidebar();
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=new-chat-empty-state]'))"), "empty conversation selected");
  for (const id of ids) await app.call("close", { id });
  await matrix("new-chat");
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ baseline, captures, liveModelCalls: 0, functional: "passed" }));
  console.log(JSON.stringify({ baseline, captures, functional: "passed" }));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), dom: await app.page.expression("document.body.innerText"), frames: await app.page.expression(`({shell:[document.querySelector('[data-test-class=conversation]')?.clientWidth,document.querySelector('[data-test-class=conversation]')?.clientHeight],canvases:[...document.querySelectorAll('${rail} [data-slot=live-tab-canvas]')].map(c=>[c.width,c.height]),cards:document.querySelectorAll('[data-slot=live-tab-card]').length})`), live: await app.main(`({visible:${browser}.areaVisible,active:${browser}.activeId,subs:[...${browser}.live.subscriptions].map(([id,s])=>({id,dirty:s.dirty,timer:!!s.timer,capturing:s.capturing,frozen:s.frozen})),pauses:[...${browser}.live.pauses]})`), toolResults: app.stub.results, renderer: await app.page.diagnostics(), view: await app.gateway.api("/session-view?session_id=general") }).replace(/(__o\/)[^/\s"\\]+/gu, "$1[redacted]"));
  throw error;
} finally { await app.stop(); }
