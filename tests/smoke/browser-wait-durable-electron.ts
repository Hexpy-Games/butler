// test-category: race
/** browser_wait_for_user in the real App: whether or not the user already took the tab, the wait
 * hands it to the user, shows the hand-off card and holds until the hand-back; Stop task ends it. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { bridgeBrowser, describeBrowser, latestBrowser } from "../support/browser-agent-stub";
import { waitBrowser } from "../support/browser-agent-app";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
type Tab = { id: string; agent: boolean; holder: string; waiting: boolean };
const tabOf = async (id: string) => (await app.call<{ tabs: Tab[] }>("state")).tabs.find(item => item.id === id)!;
const turn = async () => (await app.gateway.api<{ latest_turn?: { state: string }; active_turn?: unknown }>("/session-view?session_id=general"));
const card = "document.querySelector('[data-test-class=composer-browser-handoff]')";
const waitFor = () => bridgeBrowser("browser_wait_for_user", { tab, reason: "other" });
let tab = "";
const shot = async (name: string) => writeFileSync(join(evidence!, `${name}.png`), await app.page.screenshot());
async function handOff(label: string) {
  await waitBrowser(() => app.page.expression(`Boolean(${card})`), `${label}: hand-off card`);
  const shown = await tabOf(tab);
  assert.deepEqual([shown.holder, shown.waiting], ["user", true], `${label}: the user holds the waiting tab`);
  const text = await app.page.expression<string>(`${card}.innerText`);
  for (const line of ["Needs you in the tab", "Stop task", "Open tab"]) assert.ok(text.includes(line), `${label}: ${line} in ${text}`);
  assert.ok(!text.includes(tab) && !/Allow|Deny|risk/u.test(text), `${label}: no permission ask or tab id: ${text}`);
  await new Promise(done => setTimeout(done, 1500));
  assert.equal((await turn()).latest_turn?.state, "waiting_for_form", `${label}: still waiting for the hand-back`);
}
try {
  await app.page.reload();
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: app.url }), request => { tab = latestBrowser(request, "tab").tab as string; return null; }]);
  await app.send("Open the fixture"); await app.delivered();
  assert.ok(tab); assert.equal((await tabOf(tab)).holder, "agent");
  await app.click("General");

  // 1. Not taken over yet: the wait hands the tab to the user and holds.
  app.stub.set([describeBrowser, waitFor]);
  await app.send("Wait for me (not taken over)");
  await handOff("not taken over");
  await waitBrowser(() => app.page.expression("document.body.innerText.includes('· Needs you in the tab')"), "attention says what it waits for");
  await shot("not-taken-over-card");
  await app.call("control", { id: tab, holder: "agent" });
  await app.delivered();
  console.log("not taken over: held until the hand-back");

  // 2. Already taken over: same card, same hand-back.
  await app.call("control", { id: tab, holder: "user", sticky: true });
  app.stub.set([describeBrowser, waitFor]);
  await app.send("Wait for me (taken over)");
  await handOff("taken over");
  await app.call("control", { id: tab, holder: "agent" });
  await app.delivered();
  console.log("taken over: held until the hand-back");

  // 3. Stop task on the card ends the wait.
  app.stub.set([describeBrowser, waitFor]);
  await app.send("Wait for me, then stop");
  await handOff("stop");
  await app.page.expression(`[...${card}.querySelectorAll('button')].find(b=>b.innerText.includes('Stop task')).click()`);
  await waitBrowser(async () => !(await turn()).active_turn, "stopped turn");
  await waitBrowser(() => app.page.expression(`!${card}`), "card cleared");
  await waitBrowser(async () => (await tabOf(tab)).waiting === false, "stop clears waiting");
  await shot("stopped");
  console.log("stop: turn cancelled, wait cleared");
} catch (error) {
  await shot("failure").catch(() => {});
  console.log(JSON.stringify({ turn: (await turn().catch(() => undefined))?.latest_turn, tab: tab && await tabOf(tab).catch(() => undefined) }));
  throw error;
} finally { await app.stop(); }
