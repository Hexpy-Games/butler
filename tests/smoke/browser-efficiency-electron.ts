// test-category: race
/** Real App: a point step works on a page with a hidden iframe; observe-after-act
 * waits for the page's own request (a slow network) instead of returning the
 * loading state; an unlabeled icon carries its class words. */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, bridgeBrowser, latestBrowser } from "../support/browser-agent-stub";
import type { StubModelRequest } from "../support/native-app-server";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const stub = browserStub();
const app = await browserAgentApp(evidence, stub.handler, undefined, { stubReply: () => "Ready" });
type Session = { latest_turn?: { id: string; state: string } };
const view = () => app.gateway.api<Session>("/session-view?session_id=general");
async function send(text: string) {
  const prior = await view();
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text, client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => { const v = await view(); return v.latest_turn?.id !== prior.latest_turn?.id && v.latest_turn?.state === "delivered"; }, `${text} delivered`);
}
const text = (r: StubModelRequest) => (latestBrowser(r, "obs").untrusted_content as { text: string }).text;
const act = (steps: (r: StubModelRequest) => unknown[]) => (r: StubModelRequest) => {
  const o = latestBrowser(r, "obs");
  return bridgeBrowser("browser_act", { tab: o.tab, observation: o.obs, observe: true, steps: steps(r) });
};
const subject = (tab: string) => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)})`;
let tabId = "";
const seen: string[] = [];
const keep = <T,>(next: (r: StubModelRequest) => T) => (r: StubModelRequest): T => { seen.push(text(r)); return next(r); };
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access", language: "ko" }) });
  const content = readFileSync("packages/butler-agent/rust/crates/butler-e2e/fixtures/browser-route/slow.html", "utf8");
  stub.set([() => ({ name: "write_file", arguments: { path: "slow/index.html", content, create_parents: true } }),
    () => ({ name: "output_publish", arguments: { path: "slow", title: "Slow" } })]);
  await send("Publish slow fixture");
  const outputs = await app.gateway.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
  const artifact = outputs.artifacts.find(a => a.kind === "web"); assert.ok(artifact);
  const page = await app.gateway.api<{ url: string }>(`/outputs/${artifact.id}/view`); await app.call("open");
  stub.set([
    () => ({ name: "tool_describe", arguments: { ids: ["browser_open", "browser_observe", "browser_act"].map(n => `native:${n}`) } }),
    () => bridgeBrowser("browser_open", { url: page.url }),
    r => { tabId = String(latestBrowser(r, "tab").tab); return bridgeBrowser("browser_observe", { tab: tabId }); },
    // A point on the unlabeled icon, with a hidden iframe on the page.
    keep(act(r => { slow(true); const found = /\[[^\]]+\] center=\[(\d+),(\d+)\] expect="button icon"/u.exec(text(r)); assert.ok(found, text(r)); return [{ action: "click", point: [Number(found[1]), Number(found[2])], expect: "button icon" }]; })),
    keep(act(r => [{ action: "click", ref: /button "Search" \[([^\]]+)\]/u.exec(text(r))![1] }])),
    keep(() => null),
  ]);
  // Network latency through the page's own debugger session, so the request is real.
  function slow(on: boolean) {
    void app.main(`(async()=>{const d=${subject(tabId)}.view.webContents.debugger;if(!d.isAttached())d.attach("1.3");await d.sendCommand("Network.enable");await d.sendCommand("Network.emulateNetworkConditions",{offline:false,latency:${on ? 1500 : 0},downloadThroughput:-1,uploadThroughput:-1})})()`);
  }
  await send("Use the page.");
  writeFileSync(join(evidence, "tool-results.json"), JSON.stringify(stub.results));
  writeFileSync(join(evidence, "observations.json"), JSON.stringify(seen, null, 1));
  assert.deepEqual(stub.results.filter(r => r && typeof r === "object" && "stubFailure" in r), []);
  const results = JSON.stringify(stub.results);
  assert.ok(!results.includes("executor_error"), "a hidden iframe never breaks a point step");
  const log = await app.main<{ mode: number }>(`${subject(tabId)}.view.webContents.executeJavaScript("log")`);
  assert.equal(log.mode, 1, "the point click reached the icon");
  const [first, , searched] = seen;
  assert.match(first ?? "", /button "icon \d+×\d+ at \d+,\d+ \(class car\)"/u, "an unlabeled icon carries its class words");
  assert.match(searched ?? "", /Result ready/u, `observe-after-act waited for the request: ${searched}`);
} finally { writeFileSync(join(evidence, "tool-results-final.json"), JSON.stringify(stub.results)); await app.stop(); }
