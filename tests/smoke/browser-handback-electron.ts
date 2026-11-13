// test-category: race
/** Large text; a delegated task asks the user to sign in; the user opens the tab, the hold survives leaving it, they hand it back,
 * and the task continues in the same tab; Stop on the next hand-off card ends the wait and returns the tab to Butler. */
import { strict as assert } from "node:assert";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { bridgeBrowser, describeBrowser, latestBrowser } from "../support/browser-agent-stub";
import { waitBrowser } from "../support/browser-agent-app";
import type { StubModelRequest } from "../support/native-app-server";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
const ASK = "Open the fixture so I can sign in, then continue.";
let tab = "", observedAfterHandBack: ReturnType<typeof latestBrowser> | undefined;
const subject = () => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)})`;
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ text_size: "large" }) });
  await app.settings("en", "light", 1440);
  assert.equal(await app.main<number>(`${app.win}.webContents.getZoomFactor()`), 1.15);
  await app.main("globalThis.handbackErrors=[];process.on('uncaughtException',e=>globalThis.handbackErrors.push(String(e?.stack??e)))");
  const route = (request: StubModelRequest) => {
    if (!Array.isArray(request.body.tools) || request.body.tools.length === 0) return null;
    const users = request.messages.filter(message => (message as { role?: string }).role === "user").map(message => JSON.stringify(message));
    const child = users.some(message => message.includes("role: steward"));
    if (!child && !users.some(message => message.includes(ASK))) return null;
    const lastAsk = request.messages.findLastIndex(message => (message as { role?: string }).role === "user" && JSON.stringify(message).includes(ASK));
    const n = (child ? request.messages : request.messages.slice(lastAsk + 1)).filter(message => (message as { role?: string }).role === "tool").length;
    if (!child) return n === 0 ? { name: "delegate_to_steward", arguments: { request: ASK, checks: ["The fixture page is open."], safe_title: "Fixture sign-in" } } : null;
    if (n === 0) return { name: "replace_work_plan", arguments: { objective: ASK, execution_mode: "direct", governing_refs: [], actions: [{ action_key: "open", description: "Open the fixture", dependency_keys: [] }], checks: ["The fixture page is open."] } };
    if (n === 1) return { name: "record_work_review", arguments: { subject: "plan", verdict: "accept", summary: "Ready", corrections: [], action_updates: [] } };
    if (n === 2) return describeBrowser();
    if (n === 3) return bridgeBrowser("browser_open", { url: app.url });
    if (n === 4) return bridgeBrowser("browser_wait_for_user", { tab: latestBrowser(request, "tab").tab, reason: "sign_in" });
    if (n === 5) return bridgeBrowser("browser_observe", { tab: latestBrowser(request, "tab").tab });
    if (n === 6) {
      observedAfterHandBack = latestBrowser(request, "obs");
      return bridgeBrowser("browser_wait_for_user", { tab: observedAfterHandBack.tab, reason: "sign_in" });
    }
    return null;
  };
  app.stub.set(Array.from({ length: 64 }, () => route));
  await app.send(ASK);
  await waitBrowser(async () => (await app.call<{ tabs: Array<{ id: string; agent: boolean; waiting: boolean }> }>("state")).tabs.some(item => item.agent && item.waiting), "Butler waits for the user");
  tab = (await app.call<{ tabs: Array<{ id: string; agent: boolean; waiting: boolean }> }>("state")).tabs.find(item => item.agent && item.waiting)!.id;
  await app.click(getAppCopy("en-US").space.general);
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=composer-browser-handoff]'))"), "hand-off card");
  await app.click("Open to check");
  await waitBrowser(() => app.main<boolean>(`${subject()}.attached===${app.win} && !${subject()}.covered`), "the handed-over tab is shown");
  assert.equal(await app.main(`${subject()}.holder`), "user");
  assert.equal(await app.main(`${subject()}.sticky`), true, "opening the hand-off keeps the wait's hold");
  assert.equal(await app.main(`${subject()}.waiting`), true, "opening the hand-off keeps the wait");
  // Leaving the tab (the pane hides) never hands it back; only Give back does.
  await app.main("globalThis.browserAgentSubject.hide()");
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await app.main(`${subject()}.holder`), "user", "hiding the pane keeps the user's hold");
  assert.equal(await app.main(`${subject()}.waiting`), true, "the wait did not end before Give back");
  await app.click("Open to check");
  await waitBrowser(() => app.main<boolean>(`${subject()}.attached===${app.win} && !${subject()}.covered`), "the handed-over tab is shown again");
  assert.equal(await app.main("globalThis.browserAgentSubject.activeId"), tab);
  assert.ok(!Number.isInteger(await app.main<number>(`${subject()}.bounds.radius`)), "large text gives the pane a fractional radius");
  await app.click("Give back to Butler");
  await waitBrowser(async () => Boolean(observedAfterHandBack) &&
    (await app.call<{ tabs: Array<{ id: string; waiting: boolean }> }>("state")).tabs.some(item => item.id === tab && item.waiting) &&
    await app.page.expression<boolean>("Boolean(document.querySelector('[data-test-class=composer-browser-handoff]'))"), "the task continued in the same tab and asked again");
  assert.equal(observedAfterHandBack!.tab, tab);
  assert.doesNotMatch(JSON.stringify(app.stub.results), /browser_host_lost|executor_error|stubFailure/u);
  assert.deepEqual(await app.main("globalThis.handbackErrors"), []);
  await app.page.clickText("Stop task", '[data-test-class="composer-browser-handoff"] button');
  await waitBrowser(async () => await app.page.expression<boolean>("!document.querySelector('[data-test-class=composer-browser-handoff]')") &&
    (await app.call<{ tabs: Array<{ id: string; waiting: boolean }> }>("state")).tabs.some(item => item.id === tab && item.waiting === false), "Stop ends the delegated wait");
  const view = await app.gateway.api<any>("/session-view?session_id=general");
  assert.equal(view.steward_children[0].active_turn, null);
  assert.equal(view.steward_children[0].latest_turn?.state, "cancelled");
  assert.equal(await app.main(`${subject()}.holder`), "agent", "Stop returns the wait's tab to Butler");
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, tab }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error),
    tab: await app.main(`(()=>{const t=${subject()};return t&&{holder:t.holder,waiting:t.waiting,bounds:t.bounds,view:t.view?.getBounds(),attached:t.attached===${app.win}}})()`).catch(() => null),
    state: await app.call("state").catch(() => null), dom: await app.page.expression("document.body.innerText").catch(() => null) }, null, 2));
  await app.shot("failure").catch(() => {}); throw error;
} finally { await app.stop(); }
