// test-category: race
/** Real stub turns, native host lifetimes and renderer browser:state snapshots. */
import { expectBrowserStills } from "../support/browser-still-delivery";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, describeBrowser, bridgeBrowser, actConfirm } from "../support/browser-agent-stub";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const stub = browserStub();
const app = await browserAgentApp(evidence, stub.handler);
type Tab = { id: string; owner: string; holder: string; sticky?: boolean; inUse?: boolean; waiting: boolean };
const state = () => app.call<{ tabs: Tab[] }>("state");
// Subscribe through the production preload, including a new subscription after reload.
const rendererState = () => app.page.expression<{ tabs: Tab[] }>(`(() => {
  if (!window.browserUseSnapshotSubscribed) {
    window.browserUseSnapshotSubscribed = true;
    window.butlerBrowser.subscribe(snapshot => { window.browserUseSnapshot = snapshot; });
  }
  return window.browserUseSnapshot;
})()`);
const trace: unknown[] = [];
let tab!: Tab;
let selectedTitle = "";
async function send(label: string) {
  const prior = await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general");
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text: label, client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general")).latest_turn?.id !== prior.latest_turn?.id, "new browser turn");
}
async function terminal(expected = "delivered") {
  await waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { state: string } }>("/session-view?session_id=general")).latest_turn?.state === expected, expected);
}
async function cleared(label: string) {
  await waitBrowser(async () => !(await state()).tabs.some(item => item.inUse), label);
  await waitBrowser(async () => { const snapshot = await rendererState(); return Boolean(snapshot) && !snapshot.tabs.some(item => item.inUse); }, "renderer use cleared");
  assert.ok((await rendererState()).tabs, "renderer received browser:state");
  trace.push({ label, tabs: (await rendererState()).tabs.map(({ holder, inUse, waiting }) => ({ holder, inUse, waiting })) });
}
async function gate(op: string, fail = false) {
  await app.main(`(()=>{globalThis.browserUseGate=${JSON.stringify(op)};globalThis.browserUseFail=${fail};globalThis.browserUsePending=[]})()`);
}
async function active() {
  await waitBrowser(async () => (await state()).tabs.find(item => item.id === tab.id)?.inUse === true, "native use acquired");
  await waitBrowser(async () => (await rendererState())?.tabs.find(item => item.id === tab.id)?.inUse === true, "renderer received active tab use");
  assert.equal((await rendererState()).tabs.find(item => item.id === tab.id)?.inUse, true);
  await waitBrowser(() => app.main<boolean>("globalThis.browserUsePending.length>0"), "native call gate reached");
}
async function unblock() { await app.main("globalThis.browserUsePending.splice(0).forEach(done=>done())"); }
async function observe(label: string) {
  stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab: tab.id })]);
  await send(label); await active();
}
try {
  await app.call("open");
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: "light", access_mode: "full_access" }) });
  await app.main("(()=>{const b=globalThis.browserAgentSubject,e=b.execute;globalThis.browserUseFrames=[];b.execute=async function(frame){globalThis.browserUseFrames.push({op:frame.op,id:frame.id,turn:frame.turn_id});if(frame.op===globalThis.browserUseGate){globalThis.browserUseGate=null;await new Promise(done=>globalThis.browserUsePending.push(done));if(globalThis.browserUseFail)throw new Error('injected browser executor failure')}return e.call(this,frame)}})()");
  stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: "https://example.com" })]);
  await send("Open browser fixture"); await terminal();
  tab = (await state()).tabs.find(item => item.owner === "conversation:general")!; assert.ok(tab);
  await app.page.reload();
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
  selectedTitle = await app.page.expression<string>("document.querySelector('[data-test-class=titlebar-title]').textContent");
  assert.equal(selectedTitle, "새 대화", "hub entry retains the draft conversation as its selection");
  await app.call("activate", { id: tab.id }); await app.click("브라우저");
  await cleared("normal open completion");
  for (const theme of ["light", "dark"]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
    await app.page.reload();
    await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
    await app.call("activate", { id: tab.id }); await app.click("브라우저");
    await gate("tab.observe"); await observe(`Use browser in ${theme}`);
    await app.shot(`after-${theme}-during`);
    await unblock(); await terminal(); await cleared(`normal ${theme}`);
    await app.shot(`after-${theme}-done`);
  }
  await gate("tab.observe", true); await observe("Fail browser executor");
  await unblock(); await terminal(); await cleared("executor failure");
  await gate("tab.observe"); await observe("Timeout browser executor");
  await terminal(); await cleared("real observe timeout");
  await unblock(); await cleared("late timeout result cannot revive use");
  await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)}).view.webContents.executeJavaScript("document.body.innerHTML='<button>Confirm</button>'")`);
  await gate("tab.act");
  stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab: tab.id }), actConfirm]);
  await send("Cancel browser action"); await active();
  const stopStarted = Date.now();
  await app.page.clickText("작업 중지", '[data-test-class="browser-agent-control"] button');
  await terminal("cancelled"); await cleared("user stop");
  writeFileSync(join(evidence, "stop.json"), JSON.stringify({ owner: tab.owner, selectedTitle,
    elapsedMs: Date.now()-stopStarted, state: "cancelled", inUse: (await state()).tabs.find(item=>item.id===tab.id)?.inUse ?? false }));
  await unblock(); await cleared("late cancelled result cannot revive use");

  // Two real gateway requests to one tab: completing one must retain the other.
  const admin = (await Bun.file(join(app.gateway.butlerData, "app/runtime/auth/local-admin.json")).json()).secret as string;
  const request = () => app.gateway.api("/internal/browser/calls", { method: "POST", headers: { "x-butler-admin": admin }, body: JSON.stringify({ op: "tab.observe", session: "general", tab: tab.id, args: {} }) });
  await gate("tab.observe"); const first = request(); await active();
  await request();
  assert.equal((await state()).tabs.find(item => item.id === tab.id)?.inUse, true, "second completion cannot release the first call");
  assert.equal((await rendererState()).tabs.find(item => item.id === tab.id)?.inUse, true, "renderer retains overlapping use");
  await unblock(); await first; await cleared("last overlapping call");

  await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)}).view.webContents.executeJavaScript("document.body.innerHTML='<button>Receipt fixture</button>'")`);
  const internal = (op: string, args: unknown = {}, call_id?: string) => app.gateway.api<any>("/internal/browser/calls", { method: "POST", headers: { "x-butler-admin": admin }, body: JSON.stringify({ op, session: "general", tab: tab.id, args, call_id }) });
  const observation = await internal("tab.observe");
  const batch = { observation: observation.obs, steps: Array.from({ length: 10 }, () => ({ action: "click", ref: observation.nodes.find((node: { name: string }) => node.name === "Receipt fixture").ref })) };
  const prepared = await internal("tab.prepare", batch); assert.equal(prepared.status, "ok");
  const callId = crypto.randomUUID();
  const acting = internal("tab.act", { ...batch, prepared_steps: prepared.steps }, callId);
  await waitBrowser(() => app.main<boolean>(`Boolean(globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)}).busy)`), "native batch active");
  await internal("tab.cancel", { call_id: callId });
  const stopped = await acting; assert.equal(stopped.steps.length, 10);
  const firstUndispatched = stopped.steps.findIndex((step: { status: string }) => step.status === "not_dispatched");
  assert.ok(firstUndispatched >= 0, "cancel fences remaining input");
  assert.ok(stopped.steps.slice(firstUndispatched).every((step: { status: string }) => step.status === "not_dispatched"));
  await expectBrowserStills(app.gateway, stopped);
  assert.ok(stopped.steps.slice(0, firstUndispatched).every((step: { status: string; still_file?: string }) => step.status === "completed"));
  await cleared("cancel retains completed batch receipts");

  await gate("tab.observe"); const paneCall = request(); await active();
  await app.call("hide");
  assert.equal((await state()).tabs.find(item => item.id === tab.id)?.inUse, true, "pane close preserves the running work unit");
  await unblock(); await paneCall;
  await cleared("hidden pane call completed");
  await app.call("open"); await cleared("pane reopened");

  await gate("tab.observe"); const reconnectCall = request(); await active();
  // Public credential rotation closes the actual SSE connection and reconnects.
  await app.gateway.api("/security/connection-code/rotate", { method: "POST", headers: { "x-butler-admin": admin }, body: "{}" });
  const auth = await Bun.file(join(app.gateway.butlerData, "app/runtime/auth/local-agent-auth.json")).json();
  app.gateway.authHeaders.authorization = `Bearer ${auth.token}`;
  await cleared("gateway connection lost"); await unblock(); await reconnectCall;
  await waitBrowser(async () => {
    const response = await request() as { status?: string };
    return response.status === "ok";
  }, "real native host reconnect");
  await cleared("gateway reconnected snapshot");
  await app.page.reload();
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
  await app.call("activate", { id: tab.id }); await app.click("브라우저");
  await cleared("App renderer reconnect");

  await gate("tab.observe"); const closedCall = request(); await active();
  await app.call("close", { id: tab.id });
  assert.equal((await state()).tabs.some(item => item.inUse), false, "closed tab has no use");
  await unblock(); await closedCall; await cleared("tab closed");
  const revoked = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out" });
  const originalHolder = (await state()).tabs.find(item => item.id === revoked)!.holder;
  await app.main(`globalThis.browserAgentSubject.execute({op:'use.revoked',session:'other',tab:${JSON.stringify(revoked)},args:{}})`);
  const unchanged = (await state()).tabs.find(item => item.id === revoked); assert.ok(unchanged, "revocation respects the owner");
  assert.equal(unchanged.holder, originalHolder, "another session cannot change the holder");
  // #747: revocation hands non-agent tabs back to the user and closes only agent tabs.
  await app.main(`globalThis.browserAgentSubject.execute({op:'use.revoked',session:'general',tab:${JSON.stringify(revoked)},args:{}})`);
  const handedBack = (await state()).tabs.find(item => item.id === revoked); assert.ok(handedBack, "non-agent tab stays open");
  assert.equal(handedBack.holder, "user"); assert.equal(handedBack.sticky, true);
  const revokedAgent = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", agent: true });
  await app.main(`globalThis.browserAgentSubject.execute({op:'use.revoked',session:'other',tab:${JSON.stringify(revokedAgent)},args:{}})`);
  assert.ok((await state()).tabs.some(item => item.id === revokedAgent), "agent tab revocation respects the owner");
  const beforeRevocation = (await state()).tabs.map(item => item.id);
  await app.main(`globalThis.browserAgentSubject.execute({op:'use.revoked',session:'general',tab:${JSON.stringify(revokedAgent)},args:{}})`);
  const afterRevocation = (await state()).tabs;
  assert.deepEqual(afterRevocation.map(item => item.id), beforeRevocation.filter(id => id !== revokedAgent), "policy revocation closes the exact agent tab");
  const retained = afterRevocation.find(item => item.id === revoked); assert.ok(retained, "non-agent tab survives agent revocation");
  assert.equal(retained.holder, "user"); assert.equal(retained.sticky, true);
  await cleared("policy revocation");
  writeFileSync(join(evidence, "usage.json"), JSON.stringify({ trace, frames: await app.main("globalThis.browserUseFrames") }, null, 2));
  console.log(JSON.stringify({ status: "passed", cases: trace.length }));
} finally { await unblock().catch(() => {}); await app.stop(); }
