// test-category: race
/** Real App: a visually dense page still yields observations and a capture (the
 * JPEG is fitted to the per-image limit instead of refused), a look-never
 * observation is text only, and the capture uses the newest observation id. */
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
/** The newest tool output the stub saw: the first record carrying tool_name. */
function lastOutput(messages: unknown[]): Record<string, unknown> {
  const find = (value: unknown): Record<string, unknown> | undefined => {
    if (typeof value === "string") { try { return find(JSON.parse(value)); } catch { return undefined; } }
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.tool_name === "string") return record;
    for (const item of Object.values(record)) { const found = find(item); if (found) return found; }
    return undefined;
  };
  const tool = [...messages].reverse().find(message => (message as { role?: string }).role === "tool");
  return find(tool) ?? {};
}
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access", language: "ko" }) });
  const content = readFileSync("packages/butler-agent/rust/crates/butler-e2e/fixtures/browser-route/busy.html", "utf8");
  stub.set([() => ({ name: "write_file", arguments: { path: "busy/index.html", content, create_parents: true } }),
    () => ({ name: "output_publish", arguments: { path: "busy", title: "Busy" } })]);
  await send("Publish busy fixture");
  const outputs = await app.gateway.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
  const artifact = outputs.artifacts.find(a => a.kind === "web"); assert.ok(artifact);
  const page = await app.gateway.api<{ url: string }>(`/outputs/${artifact.id}/view`); await app.call("open");
  const seen: Array<Record<string, unknown>> = [];
  const keep = <T,>(next: (r: StubModelRequest) => T) => (r: StubModelRequest): T => { seen.push(lastOutput(r.messages)); return next(r); };
  stub.set([
    () => ({ name: "tool_describe", arguments: { ids: ["browser_open", "browser_observe", "browser_screenshot"].map(n => `native:${n}`) } }),
    () => bridgeBrowser("browser_open", { url: page.url }),
    r => bridgeBrowser("browser_observe", { tab: latestBrowser(r, "tab").tab }),
    keep(r => bridgeBrowser("browser_observe", { tab: latestBrowser(r, "tab").tab, scope: "text", look: "never" })),
    keep(r => bridgeBrowser("browser_observe", { tab: latestBrowser(r, "tab").tab })),
    keep(r => { const o = latestBrowser(r, "obs"); return bridgeBrowser("browser_screenshot", { tab: o.tab, observation: o.obs, region: [100, 100, 400, 300] }); }),
    keep(() => null),
  ]);
  await send("Look at the busy page.");
  writeFileSync(join(evidence, "tool-results.json"), JSON.stringify(stub.results));
  writeFileSync(join(evidence, "outputs.json"), JSON.stringify(seen.map(item => ({ ...item, image: item.image ? "(image)" : undefined }))));
  assert.deepEqual(stub.results.filter(r => r && typeof r === "object" && "stubFailure" in r), []);
  const [imaged, textOnly, again, capture] = seen;
  assert.equal(imaged?.status, "ok", `a dense page is observed with pixels: ${JSON.stringify(imaged)}`);
  assert.equal(textOnly?.status, "ok", `look never is text only: ${JSON.stringify(textOnly)}`);
  assert.equal(JSON.stringify(stub.results).includes("image_budget_exhausted"), false, "no image budget refusal");
  assert.equal(again?.status, "ok");
  assert.equal(capture?.schema, "butler.browser-capture.v1", `the capture uses the newest observation: ${JSON.stringify(capture)}`);
} finally { writeFileSync(join(evidence, "tool-results-final.json"), JSON.stringify(stub.results)); await app.stop(); }
