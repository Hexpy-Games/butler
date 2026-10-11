/** Real spawn + CDP: internal tool ownership and foreground conversation isolation. */
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub } from "../support/browser-agent-stub";
import { browserDelegationObjective, browserDelegationStub } from "../support/browser-delegation-stub";
import { shellReady, togglePane } from "../support/browser-shell-acceptance";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const foreground = process.env.BUTLER_BROWSER_DELEGATION_FOREGROUND === "1";
const directory = join(evidence, foreground ? "foreground" : "background"); mkdirSync(directory, { recursive: true });
const stub = browserStub();
let delegated: ReturnType<typeof browserDelegationStub> | undefined;
const app = await browserAgentApp(directory, request => delegated ? delegated(request) : stub.handler(request));
const started = Date.now();
type Tab = { id: string; owner: string; agent: boolean; title: string };
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light", access_mode: "full_access" }) });
  stub.set([
    () => ({ name: "write_file", arguments: { path: "browser-site/index.html", create_parents: true,
      content: "<!doctype html><title>Delegated browser fixture</title><h1>Parent-owned page</h1><p>Complete fixture content.</p>" } }),
    () => ({ name: "output_publish", arguments: { path: "browser-site", title: "Browser fixture" } }),
  ]);
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text: "Publish browser fixture", client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { state: string } }>("/session-view?session_id=general")).latest_turn?.state === "delivered", "fixture published");
  const artifacts = await app.gateway.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
  const output = artifacts.artifacts.find(item => item.kind === "web"); assert.ok(output);
  const view = await app.gateway.api<{ url: string }>(`/outputs/${output.id}/view`);
  delegated = browserDelegationStub(view.url);
  const other = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Current conversation" }) });
  await app.page.reload(); await shellReady(app, "en");
  if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open') === 'false'")) await app.click("Show sidebar");
  await app.click(foreground ? "General" : "Current conversation");
  const currentId = foreground ? "general" : other.session.id;
  const priorTab = await app.call<string>("create", { owner: `conversation:${currentId}`, profile: "signed_out", url: view.url });
  await app.shot("light-before-open");
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: "dark" }) });
  await app.shot("dark-before-open");
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: "light" }) });
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text: browserDelegationObjective, client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => (await app.call<{ tabs: Tab[] }>("state")).tabs.some(tab => tab.agent), "delegated browser tab");
  const db = new Database(join(app.gateway.butlerData, "agent-runtime/btcc.sqlite"), { readonly: true });
  await waitBrowser(async () => Boolean(db.query("SELECT 1 FROM btcc_guided_tool_calls WHERE tool_name='browser_tabs' AND status='completed'").get()), "delegated tools complete");
  const execution = db.query("SELECT t.session_id,c.tool_name,c.result_json FROM btcc_guided_tool_calls c JOIN btcc_turns t ON t.turn_id=c.turn_id WHERE c.tool_name IN ('browser_open','browser_observe','browser_tabs') ORDER BY c.turn_sequence").all() as Array<{ session_id: string; tool_name: string; result_json: string }>;
  db.close();
  assert.equal(execution.length, 3);
  const childId = execution[0]!.session_id; assert.notEqual(childId, "general");
  assert.ok(execution.every(call => call.session_id === childId && !call.result_json.includes(childId)));
  const state = await app.call<{ tabs: Tab[]; activeId: string }>("state");
  assert.equal(state.tabs.filter(tab => tab.agent).length, 1);
  const tab = state.tabs.find(tab => tab.agent)!; assert.equal(tab.owner, "conversation:general");
  assert.ok(!JSON.stringify(state).includes(childId) && !/steward|스튜어드/iu.test(JSON.stringify(state)));
  assert.equal(state.activeId, foreground ? tab.id : priorTab);
  // The route's title and pane are public UI proof; no test-only store mutation.
  assert.equal(await app.page.expression(`document.querySelector('[data-test-class=custom-titlebar]').textContent.includes(${JSON.stringify(foreground ? "General" : "Current conversation")})`), true);
  const text = await app.page.expression<string>("document.body.innerText");
  assert.ok(!text.includes(childId) && !/steward|스튜어드/iu.test(text), text);
  await app.shot("after-open");
  if (!foreground) {
    assert.equal(await app.page.expression("Boolean(document.querySelector('[data-slot=browser-pane]'))"), false);
    await app.click("General"); await togglePane(app, true);
  }
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=browser-pane]'))"), "parent conversation docking");
  assert.equal(await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)}).view.webContents.executeJavaScript('document.body.innerText')`), "Parent-owned page\n\nComplete fixture content.");
  for (const theme of ["light", "dark"]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme }) });
    await app.shot(`${theme}-parent-docked`);
    await app.click("Browser");
    assert.ok(!/steward|스튜어드/iu.test(await app.page.expression<string>("document.body.innerText")));
    await app.shot(`${theme}-hub`);
    await app.page.clickSelector('[data-slot="titlebar-leading"] button');
  }
  writeFileSync(join(directory, "result.json"), JSON.stringify({ ok: true, elapsedMs: Date.now() - started, foreground, currentId, owner: tab.owner, toolCount: execution.length, internalExecution: true, state }, null, 2));
} catch (error) {
  writeFileSync(join(directory, "failure.json"), JSON.stringify({ error: String(error), dom: await app.page.expression("document.body.innerText").catch(() => null) }));
  await app.shot("failure").catch(() => {}); throw error;
} finally { await app.stop(); }
