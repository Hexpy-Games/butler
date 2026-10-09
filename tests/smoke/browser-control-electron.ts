/** S3 real App control transitions, native overlay and KO/EN visual matrix. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { pointerAction, holdObservation } from "../support/browser-control-actions";
import { bridgeBrowser, describeBrowser, latestBrowser, actConfirm } from "../support/browser-agent-stub";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned } from "../support/browser-shell-acceptance";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
const started = Date.now();
let tab = "";
const subject = () => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)})`;
const overlay = "globalThis.browserAgentSubject.pointer.view.webContents";
async function hub(language: string) {
  if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open') === 'false'")) await app.click(language === "ko" ? "사이드바 보기" : "Show sidebar");
  await app.click(language === "ko" ? "브라우저" : "Browser");
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=titlebar-leading] button'))"), "hub conversation entry");
  await nativeAligned(app);
}
async function holder(value: string) {
  await waitBrowser(() => app.page.expression(`document.querySelector('[data-slot=page-card]')?.getAttribute('data-holder')===${JSON.stringify(value)}`), `holder ${value}`);
}
try {
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: app.url }), (request) => bridgeBrowser("browser_observe", { tab: latestBrowser(request, "tab").tab }), actConfirm]);
  await app.send("Browse and confirm the fixture"); await app.delivered();
  const state = await app.call<{ tabs: Array<{ id: string; agent: boolean }> }>("state");
  tab = state.tabs.find((item) => item.agent)!.id; assert.ok(tab);
  const mine = await app.call<string>("create", { url: app.url });
  await app.settings("en", "light", 1440); await app.call("activate", { id: tab }); await app.click("Browser");
  await app.page.clickSelector('[data-slot="titlebar-leading"] button');
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=page-card]'))"), "card mounted");
  await nativeAligned(app); await holder("butler");
  await pointerAction(app, tab, "click");
  await waitBrowser(() => app.main(`Boolean(globalThis.browserAgentSubject.pointer.ready && globalThis.browserAgentSubject.pointer.attached)`), "native overlay attached");
  assert.equal(await app.main(`${overlay}.executeJavaScript("document.querySelector('[data-slot=agent-pointer]')?.dataset.mode")`), "click");
  assert.equal(await app.main(`${overlay}.executeJavaScript("Boolean(window.butlerApp || window.butlerBrowser)")`), false, "overlay has no tool or credential bridge");
  // Native captures must be byte-identical with and without the visible pointer layer.
  const isolation = await app.main<{ equal: boolean; bytes: number }>(`(async()=>{
    const b=globalThis.browserAgentSubject,t=${subject()},fs=process.getBuiltinModule('fs');
    const visible=(await t.view.webContents.capturePage(undefined,{stayHidden:true})).toPNG();
    fs.writeFileSync(${JSON.stringify(join(evidence, "observation-with-overlay.png"))},visible);
    b.pointer.hide(); const hidden=(await t.view.webContents.capturePage(undefined,{stayHidden:true})).toPNG(); b.pointer.sync(t);
    fs.writeFileSync(${JSON.stringify(join(evidence, "observation-without-overlay.png"))},hidden);
    return {equal:visible.equals(hidden),bytes:visible.length};
  })()`); assert.equal(isolation.equal, true);
  // Hold a real observe call at native ingress so actual user input hits a busy Butler page.
  await app.main(`(()=>{const t=${subject()},debug=t.view.webContents.debugger,send=debug.sendCommand.bind(debug);globalThis.controlSend=send;debug.sendCommand=(method,...args)=>method==='Page.getFrameTree'?new Promise(resolve=>{debug.sendCommand=send;globalThis.controlRelease=()=>send(method,...args).then(resolve)}):send(method,...args)})()`);
  const pending = app.internal("tab.observe", tab);
  await waitBrowser(() => app.main("Boolean(globalThis.controlRelease)"), "held native observation");
  assert.equal(await app.page.expression("document.querySelector('[data-slot=page-band-actions] button').getAttribute('data-variant')"), "default");
  const blocked = await app.main(`(async()=>{const t=${subject()},p=globalThis.browserAgentSubject.pointer.view;await t.view.webContents.executeJavaScript("document.getElementById('result').textContent='Ready'");p.webContents.sendInputEvent({type:'mouseDown',x:80,y:172,button:'left',clickCount:1});p.webContents.sendInputEvent({type:'mouseUp',x:80,y:172,button:'left',clickCount:1});await new Promise(done=>setTimeout(done,50));return {text:await t.view.webContents.executeJavaScript("document.getElementById('result').textContent"),holder:t.holder}})()`);
  assert.equal((blocked as { holder: string }).holder, "agent");
  assert.equal((blocked as { text: string }).text, "Ready", "busy input cannot click the native page");
  await app.click("Take over"); await holder("user");
  await app.main(`(()=>{${subject()}.view.webContents.debugger.sendCommand=globalThis.controlSend;globalThis.controlRelease()})()`);
  assert.equal((await pending).reason, "user_control");
  await app.click("Give back to Butler"); await holder("butler");
  await app.click("Take over");
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_wait_for_user", { tab })]);
  await app.send("Wait for the user, then stop this task");
  await holder("waiting"); await app.click("Stop task");
  await waitBrowser(async () => !(await app.gateway.api<{ active_turn?: unknown }>("/session-view?session_id=general")).active_turn, "owner turn stopped");
  await waitBrowser(() => app.main(`${subject()}.waiting === false`), "stop clears browser waiting");
  const notes: unknown[] = [];
  for (const language of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.settings(language, theme, width); await app.call("activate", { id: tab }); await hub(language);
    await app.page.clickSelector('[data-slot="titlebar-leading"] button');
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=page-card]'))"), "card mounted"); await nativeAligned(app);
    await app.call("control", { id: tab, holder: "agent" }); await holder("butler");
    const prefix = `${language}-${theme}-${width}`;
    const release = await holdObservation(app, tab);
    await waitBrowser(() => app.page.expression("document.querySelector('[data-slot=page-band-actions] button').dataset.variant === 'default'"), "busy takeover emphasis");
    await app.shot(`${prefix}-agent-busy`); await release();
    for (const [name, action, batch] of [["click", "click", false], ["type", "fill", false], ["scroll", "scroll", false], ["batch", "click", true]] as const) {
      await pointerAction(app, tab, action, batch); await app.shot(`${prefix}-agent-${name}`);
      const mode = await app.main(`${overlay}.executeJavaScript("document.querySelector('[data-slot=agent-pointer]')?.dataset.mode")`);
      assert.equal(mode, name); notes.push({ prefix, mode });
    }
    await app.internal("tab.observe", tab); await app.shot(`${prefix}-agent-observe`);
    await app.internal("tab.waiting", tab, { value: true }); await holder("waiting"); await app.shot(`${prefix}-waiting`);
    await app.call("activate", { id: tab }); await holder("user");
    assert.equal(await app.main(`${subject()}.sticky`), false); await app.shot(`${prefix}-automatic-direct`);
    await app.call("activate", { id: mine }); await app.call("activate", { id: tab }); await holder("butler");
    await app.click(language === "ko" ? "직접 조작" : "Take over"); await holder("user"); await app.shot(`${prefix}-direct`);
    await app.call("activate", { id: mine }); await app.call("activate", { id: tab }); await holder("user");
    await app.click(language === "ko" ? "버틀러에게 돌려주기" : "Give back to Butler"); await holder("butler");
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ reduce_motion: true }) });
    await waitBrowser(() => app.page.expression("document.querySelector('#root').dataset.motion==='reduced'"), "reduced motion applied");
    await pointerAction(app, tab, "click"); await app.shot(`${prefix}-reduced`);
    assert.equal(await app.page.expression("getComputedStyle(document.querySelector('[data-slot=page-card]'),'::after').animationName"), "none");
    assert.equal(await app.main(`${overlay}.executeJavaScript("getComputedStyle(document.querySelector('[data-slot=agent-pointer] > :last-child')).transitionDuration")`), "0s");
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ reduce_motion: false }) });
    await app.click(language === "ko" ? "작업 중지" : "Stop task");
    await hub(language); await app.call("activate", { id: mine }); await holder("none"); await app.shot(`${prefix}-none`);
  }
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, elapsedMs: Date.now() - started, isolation, notes }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), native: await app.main("globalThis.browserAgentError").catch(() => null), state: await app.call("state"), dom: await app.page.expression("document.body.innerText").catch(() => null), diagnostics: await app.page.diagnostics() }));
  await app.shot("failure").catch(() => {}); throw error;
} finally { await app.stop(); }
