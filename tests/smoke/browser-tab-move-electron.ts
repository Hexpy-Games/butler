/** S2 actual cross-conversation pointer drop and new-conversation handover. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned } from "../support/browser-shell-acceptance";
const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
try {
  const destination = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Destination" }) });
  await app.call("open");
  const tab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: app.url });
  await app.settings("en", "light", 1440); await app.click("Browser");
  await app.page.clickSelector('[data-slot="titlebar-leading"] button');
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=browser-pane]'))"), "pane ready"); await nativeAligned(app);
  const points = await app.page.expression<{ from: { x: number; y: number }; to: { x: number; y: number } }>(`(()=>{
    const p=n=>{const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}};
    return {from:p(document.querySelector('[data-slot=tab-strip] [role=tab]')),to:p(document.querySelector('[data-tree-item="s:${destination.session.id}"] [data-test-class~="tree-row"]'))};
  })()`);
  await app.page.drag(points.from, points.to);
  await waitBrowser(() => app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).owner === ${JSON.stringify(`conversation:${destination.session.id}`)}`), "tab stays with drop destination");
  await app.internal("tabs.list", undefined, {}, destination.session.id);
  assert.equal((await app.internal("tab.observe", tab)).reason, "not_your_tab");
  assert.equal((await app.internal("tab.observe", tab, {}, destination.session.id)).status, "ok");
  await app.click("Browser"); await app.call("move", { tabId: tab, toGroupId: "mine", index: 0 }); await app.call("activate", { id: tab });
  await app.page.clickSelector('[data-slot="titlebar-leading"] button'); await app.page.clickText("New conversation", '[role="menuitem"]');
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=adaptive-shell-split-chat]'))"), "new conversation docked");
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, state: await app.call("state") }));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), state: await app.call("state"), dom: await app.page.expression("document.body.innerText") })); throw error;
} finally { await app.stop(); }
