// test-category: race
/** Real App: point clicks reach icon controls however they are drawn (image
 * replacement with hidden text, transparent text over an icon, svg <use>, a
 * pseudo-element, nested spans, under a pointer-events:none layer), and a point
 * refusal says what the point hit and which observed control is nearest. */
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
// CSS centers of the fixture's controls; the screenshot is 0.8 of the 1280×800 viewport.
const at = (x: number, y: number) => [Math.round(x * 0.8), Math.round(y * 0.8)];
const clicks: Array<[string, number[], string]> = [
  ["add", at(121, 121), "button"], ["settings", at(221, 121), "link"], ["zoom", at(321, 121), "button"],
  ["close", at(421, 121), "link"], ["share", at(121, 221), "button"],
];
const point = (where: number[], expect: string) => (r: StubModelRequest) => {
  const o = latestBrowser(r, "obs");
  return bridgeBrowser("browser_act", { tab: o.tab, observation: o.obs, observe: true, steps: [{ action: "click", point: where, expect }] });
};
let tabId = "", first = "";
/** Every object in the stub's tool results, with JSON-in-string payloads parsed. */
function records(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (typeof value === "string") { try { return records(JSON.parse(value), out); } catch { return out; } }
  if (!value || typeof value !== "object") return out;
  if (!Array.isArray(value)) out.push(value as Record<string, unknown>);
  for (const item of Object.values(value)) records(item, out);
  return out;
}
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access", language: "ko" }) });
  const content = readFileSync("packages/butler-agent/rust/crates/butler-e2e/fixtures/browser-route/icons.html", "utf8");
  stub.set([() => ({ name: "write_file", arguments: { path: "icons/index.html", content, create_parents: true } }),
    () => ({ name: "output_publish", arguments: { path: "icons", title: "Icons" } })]);
  await send("Publish icons fixture");
  const outputs = await app.gateway.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
  const artifact = outputs.artifacts.find(a => a.kind === "web"); assert.ok(artifact);
  const page = await app.gateway.api<{ url: string }>(`/outputs/${artifact.id}/view`); await app.call("open");
  stub.set([
    () => ({ name: "tool_describe", arguments: { ids: ["browser_open", "browser_observe", "browser_act"].map(n => `native:${n}`) } }),
    () => bridgeBrowser("browser_open", { url: page.url }),
    r => { tabId = String(latestBrowser(r, "tab").tab); return bridgeBrowser("browser_observe", { tab: tabId }); },
    ...clicks.map(([, where, expect], index) => (r: StubModelRequest) => { if (index === 0) first = text(r); return point(where, expect)(r); }),
    // A point on plain text beside a control.
    point(at(170, 210), "button"),
    () => null,
  ]);
  await send("Click the icons.");
  writeFileSync(join(evidence, "tool-results.json"), JSON.stringify(stub.results));
  assert.deepEqual(stub.results.filter(r => r && typeof r === "object" && "stubFailure" in r), []);
  const log = await app.main<Record<string, number>>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tabId)}).view.webContents.executeJavaScript("log")`);
  for (const [id] of clicks) assert.equal(log[id], 1, `the point click reached ${id}: ${JSON.stringify(log)} ${JSON.stringify(stub.results).match(/not_actionable|point_mismatch|transparent_overlay/gu)}`);
  assert.match(first, /button "Add stop" \[/u, `an image-replaced button is observed with its hidden label: ${first}`);
  const refusal = records(stub.results).find(record => record.status === "refused" && Array.isArray(record.rejected_point)) as
    { hit?: { role?: string; name?: string; class_words?: unknown; rect?: number[] }; nearest?: { ref?: string; role?: string; point?: number[] } } | undefined;
  assert.ok(refusal, "the plain-text point is refused");
  assert.ok(refusal.hit?.role === "p" && refusal.hit.name?.startsWith("Plain words") && Array.isArray(refusal.hit.class_words) && refusal.hit.rect?.length === 4,
    `the refusal says what the point hit: ${JSON.stringify(refusal)}`);
  assert.ok(refusal.nearest?.ref && refusal.nearest.role === "button" && refusal.nearest.point?.length === 2, `and the nearest observed control with its point: ${JSON.stringify(refusal)}`);
} finally { writeFileSync(join(evidence, "tool-results-final.json"), JSON.stringify(stub.results)); await app.stop(); }
