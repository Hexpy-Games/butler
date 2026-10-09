// test-category: security
/** S4 through the real Electron App and durable public approval lane; stub only. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, describeBrowser, bridgeBrowser, latestBrowser } from "../support/browser-agent-stub";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const awaitableFixture = await Bun.file(resolve("tests/fixtures/browser/S4/index.html")).text();
const popupFixture = await Bun.file(resolve("tests/fixtures/browser/S4/popup.html")).text();

const cases = ["ko-light-1440", "ko-light-1100", "ko-dark-1440", "ko-dark-1100", "en-light-1440", "en-light-1100", "en-dark-1440", "en-dark-1100", "agent"];
if (await runSmokeCases(cases, "BUTLER_BROWSER_S4_CASE", import.meta.path)) process.exit(0);
const selected = process.env.BUTLER_BROWSER_S4_CASE;
const started = Date.now();
const stub = browserStub();
const posts: Array<{ path: string; body: string }> = [];
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const path = new URL(request.url).pathname;
  if (request.method === "POST") posts.push({ path, body: await request.text() });
  if (path === "/post-navigation") return new Response("<title>POST accepted</title><h1>Original POST accepted</h1>", { headers: { "content-type": "text/html" } });
  if (path === "/auth" && request.headers.get("authorization") !== `Basic ${btoa("fixture:fixture")}`) return new Response("Sign in", { status: 401, headers: { "www-authenticate": 'Basic realm="Fixture"' } });
  const file = path === "/auth" ? "basic-auth.html" : path.endsWith("popup.html") ? "popup.html" : "index.html";
  return new Response(Bun.file(resolve("tests/fixtures/browser/S4", file)), { headers: { "content-type": "text/html; charset=utf-8" } });
} });
const app = await browserAgentApp(evidence, stub.handler);
interface Tab { id: string; owner: string; agent?: boolean; holder: string; dialog?: { id: string; type: string }; blockedPopup?: unknown; }
const state = () => app.call<{ tabs: Tab[] }>("state");
const contents = (id: string) => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).view.webContents`;
const facts: unknown[] = [];
const send = async (text: string) => {
  const prior = await app.gateway.api<any>("/session-view?session_id=general");
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text, client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => (await app.gateway.api<any>("/session-view?session_id=general")).latest_turn?.id !== prior.latest_turn?.id, "new stub turn");
};
const delivered = () => waitBrowser(async () => (await app.gateway.api<any>("/session-view?session_id=general")).latest_turn?.state === "delivered", "stub delivered");
async function nativeClick(id: string, selector: string) {
  await app.main(`(async()=>{const t=globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)});const w=t.view.webContents;
    const point=await w.executeJavaScript(${JSON.stringify(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.scrollIntoView({block:'center'});const b=n.getBoundingClientRect();if(!n.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)))throw Error('target not hit-testable');return{x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`)});
    (t.popupWindow ?? ${app.win}).focus();w.focus();w.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});w.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
  })()`);
}
async function dialog(id: string, type: string) {
  await nativeClick(id, `#${type}`);
  await waitBrowser(async () => (await state()).tabs.find(t => t.id === id)?.dialog?.type === type, `user ${type}`);
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="browser-page-dialog"]')));
  assert.equal(await app.main(`${contents(id)}.debugger.isAttached()`), false, "no debugger on a user tab");
  assert.equal(await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).attached === null`), true, "native view occluded before DS dialog");
}
async function answer(id: string, accept: boolean, extra = {}) {
  const current = (await state()).tabs.find(t => t.id === id)!;
  await app.call("dialog", { id, dialog: current.dialog!.id, accept, ...extra });
  await waitBrowser(async () => !(await state()).tabs.find(t => t.id === id)?.dialog, "dialog closed");
}
async function popupShot(name: string, parent: string) {
  await waitBrowser(() => app.main(`[...globalThis.browserAgentSubject.tabs.values()].some(t=>t.opener===${JSON.stringify(parent)})`), "popup created");
  const child = await app.main<string>(`[...globalThis.browserAgentSubject.tabs.values()].find(t=>t.opener===${JSON.stringify(parent)})?.id`);
  assert.ok(child);
  await waitBrowser(() => app.main(`(()=>{const t=globalThis.browserAgentSubject.tabs.get(${JSON.stringify(child)});return Boolean(t?.popupWindow?.isVisible() && t.attached===t.popupWindow)})()`), "popup chrome and native page shown");
  const capture = process.env.BUTLER_WINDOW_CAPTURE_EXECUTABLE; assert.ok(capture);
  const source = await app.main<string>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(child)}).popupWindow.getMediaSourceId()`);
  assert.equal(Bun.spawnSync([capture, source.split(":")[1]!, join(evidence!, `${name}.png`)]).exitCode, 0);
  assert.equal(await app.main(`${contents(child)}.executeJavaScript("Boolean(opener)")`), true);
  await nativeClick(child, "#complete");
  await waitBrowser(() => app.main(`!globalThis.browserAgentSubject.tabs.has(${JSON.stringify(child)})`), "popup closes");
  await app.main(`${app.win}.focus()`);
  if (!name.includes("allowed-once")) await waitBrowser(() => app.main(`${contents(parent)}.executeJavaScript("document.querySelector('#result').textContent !== 'Ready'")`), "postMessage returns to opener");
  console.log(`popup passed ${name}`);
}
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light", access_mode: "full_access" }) });
  await app.page.reload(); await app.click("Browser");
  const mine = await app.call<string>("create", { url: server.url.href });
  await app.main(`(()=>{globalThis.s4CloseTrace=[];const b=globalThis.browserAgentSubject,w=${contents(mine)},close=b.close;b.close=function(id){s4CloseTrace.push({op:'close',id,stack:new Error().stack});return close.call(this,id)};w.on('will-prevent-unload',e=>s4CloseTrace.push({op:'prevent',prevented:e.defaultPrevented}));w.on('destroyed',()=>s4CloseTrace.push({op:'destroyed'}))})()`);
  await waitBrowser(() => app.main(`${contents(mine)}.executeJavaScript("Boolean(document.querySelector('#confirm'))")`), "fixture loaded");
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    if (selected && selected !== `${locale}-${theme}-${width}`) continue;
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
    await app.main(`${app.win}.setContentSize(${width},900)`); await app.page.reload();
    await app.click(locale === "ko" ? "브라우저" : "Browser"); await app.call("activate", { id: mine });
    const name = `${locale}-${theme}-${width}`;
    await app.shot(`${name}-before`);
    for (const flow of ["oauth", "payment", "postcode", "blank"]) {
      await app.main(`${contents(mine)}.executeJavaScript("document.querySelector('#result').textContent='Ready'")`);
      await nativeClick(mine, `#${flow}`); await popupShot(`${name}-${flow}-popup`, mine);
    }
    if (name === "ko-light-1440") {
      await app.main(`${contents(mine)}.executeJavaScript("document.querySelector('#result').textContent='Ready'")`);
      await nativeClick(mine, "#payment-post"); await popupShot(`${name}-payment-post-popup`, mine);
      assert.deepEqual(posts.at(-1), { path: "/popup.html", body: "challenge=fixture-3ds" }, "payment POST preserved in original popup");
    }
    await app.main(`${contents(mine)}.executeJavaScript("setTimeout(()=>open('popup.html?flow=ad'),0)")`);
    await waitBrowser(async () => Boolean((await state()).tabs.find(t => t.id === mine)?.blockedPopup), "non-gesture popup blocked");
    await app.shot(`${name}-blocked`); await app.click(locale === "ko" ? "허용" : "Allow");
    await popupShot(`${name}-allowed-once-popup`, mine);
    for (const type of ["alert", "confirm", "prompt", "print"]) {
      await dialog(mine, type); await app.shot(`${name}-${type}`);
      await answer(mine, type !== "print", { value: "Owner answer" });
    }
    await nativeClick(mine, "#beforeunload"); await app.call("close", { id: mine });
    await waitBrowser(async () => (await state()).tabs.find(t => t.id === mine)?.dialog?.type === "beforeunload", "beforeunload anchored");
    await app.shot(`${name}-beforeunload`);
    if (name === "ko-light-1100") {
      await new Promise(done => setTimeout(done, 10_000));
      assert.equal((await state()).tabs.find(t => t.id === mine)?.dialog?.type, "beforeunload", "owner wait outlives Chromium's unload watchdog");
    }
    await answer(mine, false);
    assert.ok((await state()).tabs.some(t => t.id === mine), "cancel retains the tab after the native close attempt");
    await app.call("navigate", { id: mine, value: `${server.url.href}?leave=1` });
    await waitBrowser(async () => (await state()).tabs.find(t => t.id === mine)?.dialog?.type === "beforeunload", "navigation beforeunload");
    await answer(mine, true);
    await waitBrowser(() => app.main(`${contents(mine)}.getURL().endsWith('?leave=1') && !${contents(mine)}.isLoading()`), "approved navigation loaded");
    assert.equal(await app.main(`${contents(mine)}.executeJavaScript("location.search==='?leave=1'")`), true, "approved navigation reaches its destination");
    if (name === "ko-light-1440") {
      await app.main(`${contents(mine)}.executeJavaScript("window.onbeforeunload=null;window.leaveListener=e=>e.preventDefault();addEventListener('beforeunload',leaveListener);void 0")`);
      const count = posts.length;
      for (const accept of [false, true]) {
        await nativeClick(mine, "#leave-post");
        await waitBrowser(async () => (await state()).tabs.find(t => t.id === mine)?.dialog?.type === "beforeunload", "POST beforeunload");
        await answer(mine, accept);
        if (!accept) assert.equal(posts.length, count, "cancel prevents the original POST");
      }
      await waitBrowser(() => app.main(`${contents(mine)}.getURL().endsWith('/post-navigation') && !${contents(mine)}.isLoading()`), "original POST navigation completes");
      assert.deepEqual(posts.at(-1), { path: "/post-navigation", body: "intent=fixture-navigation" });
      assert.equal(posts.length, count + 1, "approval never replays the POST");
    }
    await app.call("navigate", { id: mine, value: `${server.url.href}auth` });
    await waitBrowser(async () => (await state()).tabs.find(t => t.id === mine)?.dialog?.type === "auth", "HTTP basic auth DS sign-in");
    await app.shot(`${name}-auth`); await answer(mine, true, { username: "fixture", password: "fixture" });
    await waitBrowser(() => app.main(`${contents(mine)}.getURL().endsWith('/auth') && !${contents(mine)}.isLoading()`), "basic auth loaded");
    assert.equal(await app.main(`${contents(mine)}.executeJavaScript("document.body.innerText.includes('Basic auth accepted')")`), true, "basic auth submitted");
    if (!selected) await app.main(`${contents(mine)}.session.clearAuthCache()`);
    await app.call("navigate", { id: mine, value: server.url.href });
    await waitBrowser(() => app.main(`${contents(mine)}.executeJavaScript("Boolean(document.querySelector('#upload'))")`), "fixture reload");
    await nativeClick(mine, "#upload");
    await waitBrowser(async () => (await state()).tabs.find(t => t.id === mine)?.dialog?.type === "file", "file DS sheet");
    await app.shot(`${name}-file`);
    await app.page.expression(`(()=>{const input=document.querySelector('[data-test-class="browser-page-dialog"] input[type=file]'),transfer=new DataTransfer();transfer.items.add(new File(['fixture bytes'],'fixture.txt',{type:'text/plain'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await app.click(locale === "ko" ? "확인" : "OK");
    await waitBrowser(async () => !(await state()).tabs.find(t => t.id === mine)?.dialog, "file owner answer delivered");
    assert.equal(await app.main(`${contents(mine)}.executeJavaScript("document.querySelector('#upload').files[0].text()")`), "fixture bytes");
    facts.push({ locale, theme, width, user: "passed" });
  }
  if (!selected || selected === "agent") {
  stub.set([
    () => ({ name: "write_file", arguments: { path: "s4/index.html", create_parents: true, content: awaitableFixture } }),
    () => ({ name: "write_file", arguments: { path: "s4/popup.html", content: popupFixture } }),
    () => ({ name: "output_publish", arguments: { path: "s4", title: "S4 fixture" } }),
  ]);
  await send("Publish S4 fixtures"); await delivered();
  const artifacts = await app.gateway.api<any>("/artifacts?session_id=general");
  const output = artifacts.artifacts.find((item: any) => item.kind === "web"); assert.ok(output);
  const view = await app.gateway.api<{ url: string }>(`/outputs/${output.id}/view`);
  stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: view.url })]);
  await send("Open S4 fixture"); await delivered();
  const agent = (await state()).tabs.find(t => t.agent)!; assert.ok(agent);
  await app.main(`${contents(agent.id)}.executeJavaScript("window.s4Errors=[];addEventListener('error',e=>s4Errors.push(e.message));void 0")`);
  for (const kind of ["oauth", "payment", "postcode", "blank"]) {
    await app.main(`${contents(agent.id)}.executeJavaScript(${JSON.stringify(`document.querySelector('#${kind}').click()`)})`);
    await waitBrowser(async () => (await state()).tabs.some(t => t.owner === agent.owner && t.id !== agent.id && t.agent), "agent popup grouped");
    const child = (await state()).tabs.find(t => t.owner === agent.owner && t.id !== agent.id && t.agent)!;
    assert.equal(await app.main(`${contents(child.id)}.executeJavaScript("Boolean(opener)")`), true);
    await assert.rejects(app.call("move", { tabId: child.id, toGroupId: "mine", index: 0 }), /invalid_popup_owner/u);
    assert.equal((await state()).tabs.find(t => t.id === child.id)?.owner, agent.owner, "popup remains bound to its opener owner");
    await app.call("close", { id: child.id });
  }
  await app.main(`${contents(agent.id)}.executeJavaScript("document.querySelector('#unknown').click()")`);
  await waitBrowser(async () => Boolean((await state()).tabs.find(t => t.id === agent.id)?.blockedPopup), "unknown agent popup blocked");
  stub.set([describeBrowser, () => bridgeBrowser("browser_tabs", {})]); await send("Read popup events"); await delivered();
  assert.ok(JSON.stringify(stub.results).includes("popup_opened")); assert.ok(JSON.stringify(stub.results).includes("popup_blocked"));
  const act = (type: string) => {
    stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab: agent.id }), request => {
      const observation = latestBrowser(request, "obs");
      const text = (observation.untrusted_content as { text: string }).text;
      const ref = new RegExp(`button "${type}" \\[([^\\]]+)\\]`, "u").exec(text)?.[1]; assert.ok(ref, text);
      return bridgeBrowser("browser_act", { tab: agent.id, observation: observation.obs, steps: [{ action: "click", ref }] });
    }]);
  };
  act("Alert"); await send("Read and dismiss alert"); await delivered();
  assert.ok(JSON.stringify(stub.results).includes("Page alert"));
  act("Confirm"); await send("Ask owner to confirm");
  await waitBrowser(async () => (await app.gateway.api<any>("/authority-requests?session_id=general")).requests.length === 1, "durable dialog approval");
  const request = (await app.gateway.api<any>("/authority-requests?session_id=general")).requests[0];
  const epoch = await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(agent.id)}).epoch`);
  await app.call("activate", { id: agent.id });
  assert.equal(await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(agent.id)}).epoch`), epoch, "viewing a pending dialog does not take over its authority");
  assert.equal((await state()).tabs.find(t => t.id === agent.id)?.holder, "agent");
  assert.equal(request.approval.operation.allow_conversation, false);
  assert.ok(request.approval.operation.targets.some((target: string) => target.includes("Continue?")));
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
    await app.main(`${app.win}.setContentSize(${width},900)`); await app.page.reload();
    await app.click(locale === "ko" ? "일반" : "General");
    await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="composer-authority-decision"]')));
    assert.equal(await app.main(`[...globalThis.browserAgentSubject.tabs.values()].some(t=>t.attached===${app.win})`), false, "no native page obscures the conversation approval");
    await app.shot(`${locale}-${theme}-${width}-agent-confirm-approval`);
  }
  const browser = await launchSmokeBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); await app.gateway.signIn(context);
    const phone = await context.newPage();
    for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) {
      await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
      await phone.goto(app.gateway.url);
      await phone.getByRole("button", { name: locale === "ko" ? "사이드바 보기" : "Show sidebar", exact: true }).click();
      await phone.getByText(locale === "ko" ? "일반" : "General", { exact: true }).first().click();
      await phone.getByRole("button", { name: locale === "ko" ? "이번만 허용" : "Allow once", exact: true }).waitFor();
      assert.ok((await phone.locator('[data-test-class="composer-authority-decision"]').innerText()).includes("Continue?"));
      assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await phone.screenshot({ path: join(evidence, `${locale}-${theme}-390-agent-confirm-approval.png`) });
    }
    await phone.getByRole("button", { name: "Allow once", exact: true }).click(); await delivered();
    assert.equal(await app.main(`${contents(agent.id)}.executeJavaScript("window.clicks")`), 1, "approval resumes without replay");
  } finally { await browser.close(); }
  for (const type of ["Prompt", "Beforeunload"]) {
    // Page-originated dialogs also need authority while the tab is hidden.
    const click = `document.querySelector('#${type.toLowerCase()}').click()`;
    if (type === "Beforeunload") await app.main(`${contents(agent.id)}.executeJavaScript(${JSON.stringify(click)})`);
    else {
      await app.main(`(()=>{void ${contents(agent.id)}.executeJavaScript(${JSON.stringify(click)})})()`);
      await waitBrowser(async () => (await state()).tabs.find(t => t.id === agent.id)?.dialog?.type === "prompt", "page-originated prompt intercepted");
    }
    stub.set([describeBrowser, () => bridgeBrowser(type === "Beforeunload" ? "browser_close" : "browser_observe", { tab: agent.id })]);
    await send(`Ask owner for ${type}`);
    await waitBrowser(async () => (await app.gateway.api<any>("/authority-requests?session_id=general")).requests.length === 1, `durable ${type} approval`);
    const approval = (await app.gateway.api<any>("/authority-requests?session_id=general")).requests[0];
    assert.equal(approval.approval.operation.allow_conversation, false);
    if (type === "Prompt") assert.ok(approval.approval.operation.targets.some((target: string) => target.includes("Guest")));
    await app.gateway.api(`/authority-requests/${approval.request_ref}/allow?session_id=general`, { method: "POST", body: JSON.stringify({ scope: "once" }) }); await delivered();
    if (type === "Prompt") assert.equal(await app.main(`${contents(agent.id)}.executeJavaScript("document.querySelector('#result').textContent")`), "Guest");
  }
  assert.equal((await state()).tabs.some(t=>t.id===agent.id), false, "approved beforeunload closes the tab");
  stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: view.url })]); await send("Open hidden timeout fixture"); await delivered();
  const hidden = (await state()).tabs.find(t=>t.agent)!;
  // Production deadline: do not shorten it or replay to make this green.
  await app.main(`(()=>{const b=globalThis.browserAgentSubject;b.hide();void ${contents(hidden.id)}.executeJavaScript("confirm('Hidden timeout')")})()`);
  await waitBrowser(async () => Boolean((await state()).tabs.find(t => t.id === hidden.id)?.dialog), "hidden dialog intercepted");
  await new Promise(done => setTimeout(done, 121_000));
  assert.equal((await state()).tabs.find(t => t.id === hidden.id)?.dialog, null);
  stub.set([describeBrowser, () => bridgeBrowser("browser_tabs", {})]); await send("Read timeout event"); await delivered();
  const timeoutEvent = (value: unknown): boolean => {
    if (typeof value === "string") { try { return timeoutEvent(JSON.parse(value)); } catch { return false; } }
    if (!value || typeof value !== "object") return false;
    const event = value as { type?: string; reason?: string };
    return event.type === "dialog_cancelled" && event.reason === "timeout" || Object.values(value).some(timeoutEvent);
  };
  assert.ok(timeoutEvent(stub.results), "next tool result reports timeout cancellation");
  }
  writeFileSync(join(evidence, `acceptance-${selected ?? "all"}.json`), JSON.stringify({ status: "passed", elapsedMs: Date.now() - started, facts, toolResults: stub.results }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), lastMain: app.lastMain(), closeTrace: await app.main("globalThis.s4CloseTrace").catch(()=>null), state: await state().catch(() => null), mainError: await app.main("globalThis.browserAgentError").catch(() => null), native: await app.main(`(async()=>{const t=[...globalThis.browserAgentSubject.tabs.values()].find(t=>t.agent);return t&&{bounds:t.bounds,view:t.view?.getBounds(),focused:t.view?.webContents.isFocused(),dialog:t.dialog?.type,body:!t.dialog?await t.view?.webContents.executeJavaScript("({errors:window.s4Errors,result:document.querySelector('#result')?.textContent,prompt:String(prompt),scroll:[scrollX,scrollY],size:[innerWidth,innerHeight]})"):null}})()`).catch(()=>null), toolResults: stub.results, dom: await app.page.diagnostics().catch(() => null) }, null, 2));
  throw error;
} finally { server.stop(true); await app.stop(); }
