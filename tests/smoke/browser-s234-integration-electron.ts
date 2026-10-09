// test-category: security
/** S2 ownership, S3 holders/pointer and S4 native dialogs in the same real App. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { describeBrowser, bridgeBrowser } from "../support/browser-agent-stub";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
type Tab = { id: string; owner: string; holder: string; waiting: boolean; dialog?: { id: string }; opener?: string };
const state = () => app.call<{ tabs: Tab[] }>("state");
const tabExpr = (id: string) => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)})`;
const page = (id: string, expression: string) => app.main(`${tabExpr(id)}.view.webContents.executeJavaScript(${JSON.stringify(expression)})`);
const facts: unknown[] = [];

async function popup(parent: string, owner: string) {
  await page(parent, `void window.open(${JSON.stringify(app.url)},'_blank')`);
  await waitBrowser(async () => (await state()).tabs.some(t => t.opener === parent), "agent popup grouped");
  const child = (await state()).tabs.find(t => t.opener === parent)!;
  assert.equal(child.owner, owner);
  assert.equal(child.holder, "agent");
  await waitBrowser(() => app.main(`${tabExpr(child.id)}.loaded === true`), "popup loaded");
  assert.equal(await page(child.id, "Boolean(opener)"), true);
  return child;
}

async function dialogHolder(id: string) {
  await app.call("activate", { id }); await app.click("Browser");
  await waitBrowser(() => app.main(`${tabExpr(id)}.attached === ${app.win}`), "native page visible");
  await app.main(`globalThis.browserAgentSubject.pointer.action(${tabExpr(id)},{mode:'observe'})`);
  await waitBrowser(() => app.main("globalThis.browserAgentSubject.pointer.ready === true"), "pointer ready");
  assert.equal(await app.main(`(()=>{const b=globalThis.browserAgentSubject,v=${app.win}.contentView.children;return v.indexOf(b.pointer.view)>v.indexOf(${tabExpr(id)}.view)})()`), true, "pointer above native page");
  await app.shot("pointer-above-page");
  await app.main(`(()=>{void ${tabExpr(id)}.view.webContents.executeJavaScript("confirm('Combined approval')")})()`);
  await waitBrowser(async () => Boolean((await state()).tabs.find(t => t.id === id)?.dialog), "tab-anchored dialog");
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=browser-page-dialog]'))"), "dialog drawn");
  assert.equal(await app.main("globalThis.browserAgentSubject.pointer.attached === null"), true, "native pointer cannot obscure DOM dialog");
  assert.equal(await app.main(`${tabExpr(id)}.attached !== ${app.win}`), true, "native page below DOM dialog");
  // A real guided browser observation enters the durable approval lane.
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_observe", { tab: id })]);
  await app.send("Ask owner about combined dialog");
  await waitBrowser(async () => (await app.gateway.api<any>("/authority-requests?session_id=general")).requests.length === 1, "approval card waiting");
  for (const theme of ["light", "dark"]) {
    await app.settings("en", theme, 1440); await app.click("Browser");
    await app.call("activate", { id });
    await waitBrowser(() => app.page.expression("document.querySelector('[data-slot=page-card]')?.dataset.holder === 'waiting'"), "waiting PageCard");
    assert.equal(await app.page.expression("document.querySelector('[data-test-class=browser-agent-control]')?.getAttribute('data-tone')"), "waiting");
    await app.shot(`${theme}-dialog-waiting`);
  }
  // Host connection reset and exact turn release must preserve page-owned waiting.
  await app.main(`(async()=>{const b=globalThis.browserAgentSubject,t=${tabExpr(id)};t.waitingTurn='combined';await b.execute({op:'use.finished',session:'general',turn_id:'combined'})})()`);
  assert.equal((await state()).tabs.find(t => t.id === id)?.waiting, true, "exact turn release preserves dialog waiting");
  await app.main("globalThis.browserAgentSubject.resetUse()");
  assert.equal((await state()).tabs.find(t => t.id === id)?.waiting, true, "use reset preserves dialog waiting");
  await app.internal("tab.waiting", id, { value: false });
  assert.equal((await state()).tabs.find(t => t.id === id)?.waiting, true, "turn waiting release preserves dialog waiting");
  await app.click("General");
  await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="composer-authority-decision"]')));
  await app.shot("combined-approval-card");
  const approval = (await app.gateway.api<any>("/authority-requests?session_id=general")).requests[0];
  assert.ok(approval.approval.operation.targets.some((target: string) => target.includes("Combined approval")));
  await app.gateway.api(`/authority-requests/${approval.request_ref}/allow?session_id=general`, { method: "POST", body: JSON.stringify({ scope: "once" }) });
  await app.delivered();
  await waitBrowser(async () => !(await state()).tabs.find(t => t.id === id)?.dialog, "approved dialog closed");
  facts.push({ case: "dialog-holder-pointer-approval", status: "passed" });
}

async function ownership(id: string) {
  const destination = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Destination" }) });
  const owner = `conversation:${destination.session.id}`;
  const first = await popup(id, "conversation:general");
  await app.main("(()=>{const b=globalThis.browserAgentSubject,execute=b.execute;globalThis.combinedPending=[];b.execute=async function(frame){if(frame.op==='tab.observe' && " + JSON.stringify([id, first.id]) + ".includes(frame.tab)){await new Promise(done=>combinedPending.push(done));}return execute.call(this,frame)}})()");
  const pending = app.internal("tab.observe", id);
  const pendingPopup = app.internal("tab.observe", first.id);
  await waitBrowser(() => app.main("globalThis.combinedPending.length===2"), "inflight opener and popup observations");
  await app.call("move", { tabId: id, toGroupId: owner, index: 0 });
  assert.equal((await state()).tabs.some(t => t.id === first.id), false, "old popup closes on opener move");
  await app.main("globalThis.combinedPending.splice(0).forEach(done=>done())");
  assert.equal((await pending).reason, "owner_changed");
  assert.equal((await pendingPopup).reason, "owner_changed");
  assert.equal((await app.internal("tab.observe", id)).reason, "not_your_tab");
  const child = await popup(id, owner);
  assert.equal((await app.internal("tab.observe", child.id)).reason, "not_your_tab");
  assert.equal((await app.internal("tab.observe", child.id, {}, destination.session.id)).status, "ok");
  const events = await app.internal("tabs.list", undefined, {}, destination.session.id);
  assert.ok(events.tabs.some((t: Tab) => t.id === child.id && t.owner === owner));
  facts.push({ case: "popup-after-opener-move", status: "passed", owner });
}

try {
  await app.call("open");
  const opened = await app.internal("tab.open", undefined, { url: app.url });
  assert.equal(opened.status, "ok");
  await dialogHolder(opened.tab);
  await ownership(opened.tab);
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ status: "passed", facts }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), state: await state().catch(() => null), dom: await app.page.diagnostics().catch(() => null) }, null, 2));
  await app.shot("failure").catch(() => {}); throw error;
} finally { await app.stop(); }
