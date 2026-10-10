// test-category: race
/** Real App: short ids, generic control states, close-ups, history steps and an
 * approved workspace upload through the page's own file chooser. */
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
async function send(text: string, approve = false) {
  const prior = await view();
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text, client_message_id: crypto.randomUUID() }) });
  if (approve) {
    type Requests = { requests: Array<{ request_ref: string; approval: { operation: { targets: string[]; allow_conversation: boolean; browser_steps?: Array<{ action: string; value_preview?: string }> } } }> };
    await waitBrowser(async () => (await app.gateway.api<Requests>("/authority-requests?session_id=general")).requests.length === 1, "upload approval");
    const request = (await app.gateway.api<Requests>("/authority-requests?session_id=general")).requests[0]!;
    writeFileSync(join(evidence!, "upload-approval.json"), JSON.stringify(request.approval));
    assert.equal(request.approval.operation.allow_conversation, false, "uploads are always confirmed");
    assert.ok(request.approval.operation.browser_steps?.some(step => step.action === "upload" && step.value_preview === "sample.txt"), "the card names the file");
    await app.gateway.api(`/authority-requests/${request.request_ref}/allow?session_id=general`, { method: "POST", body: JSON.stringify({ scope: "once" }) });
  }
  await waitBrowser(async () => { const v = await view(); return v.latest_turn?.id !== prior.latest_turn?.id && v.latest_turn?.state === "delivered"; }, `${text} delivered`);
}
/** Tool results nest JSON in strings; flatten every string leaf for plain matching. */
function flat(value: unknown): string {
  if (typeof value === "string") { try { return flat(JSON.parse(value)); } catch { return value; } }
  if (!value || typeof value !== "object") return String(value ?? "");
  if (Array.isArray(value)) return value.map(flat).join("\n");
  return Object.entries(value as Record<string, unknown>).map(([key, item]) => typeof item === "string" && !item.startsWith("{") ? `"${key}":"${item}"` : flat(item)).join("\n");
}
const ref = (r: StubModelRequest, pattern: RegExp) => {
  const text = (latestBrowser(r, "obs").untrusted_content as { text: string }).text;
  const found = pattern.exec(text)?.[1]; assert.ok(found, text); return found;
};
const act = (steps: (r: StubModelRequest) => unknown[]) => (r: StubModelRequest) => {
  const o = latestBrowser(r, "obs");
  return bridgeBrowser("browser_act", { tab: o.tab, observation: o.obs, observe: true, steps: steps(r) });
};
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access", language: "ko" }) });
  const content = readFileSync("packages/butler-agent/rust/crates/butler-e2e/fixtures/browser-route/round2.html", "utf8");
  stub.set([() => ({ name: "write_file", arguments: { path: "round2/index.html", content, create_parents: true } }),
    () => ({ name: "output_publish", arguments: { path: "round2", title: "Round two" } })]);
  await send("Publish round two fixture");
  const outputs = await app.gateway.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
  const artifact = outputs.artifacts.find(a => a.kind === "web"); assert.ok(artifact);
  const page = await app.gateway.api<{ url: string }>(`/outputs/${artifact.id}/view`); await app.call("open");
  stub.set([
    () => ({ name: "tool_describe", arguments: { ids: ["browser_open", "browser_observe", "browser_act"].map(n => `native:${n}`) } }),
    () => bridgeBrowser("browser_open", { url: page.url }),
    r => bridgeBrowser("browser_observe", { tab: latestBrowser(r, "tab").tab }),
    r => { const o = latestBrowser(r, "obs"); return bridgeBrowser("browser_observe", { tab: o.tab, region: [30, 90, 160, 50], scale: 3 }); },
    act(r => [{ action: "click", ref: ref(r, /element "Pencil" \[([^\]]+)\]/u) }]),
    act(r => [{ action: "click", ref: ref(r, /link "Next page" \[([^\]]+)\]/u) }]),
    act(() => [{ action: "back" }]),
    act(() => [{ action: "forward" }]),
    act(() => [{ action: "reload" }]),
  ]);
  await send("Use the controls.");
  writeFileSync(join(evidence, "tool-results.json"), JSON.stringify(stub.results));
  assert.deepEqual(stub.results.filter(r => r && typeof r === "object" && "stubFailure" in r), []);
  const first = flat(stub.results);
  assert.match(first, /"tab":"t[0-9a-z]{6}"/u, "tabs have short ids");
  assert.match(first, /"obs":"o1"/u, "observations have short ids");
  assert.match(first, /element "Line" \[[^\]]+\][^\n]*state=active/u, "a selected tool shows its active state");
  assert.match(first, /button "Bold" \[[^\]]+\][^\n]*state=pressed/u, "aria-pressed is exposed");
  assert.match(first, /element "Pencil" \[[^\]]+\][^\n]*state=active/u, "state follows the click");
  assert.ok(first.includes("butler.browser-zoom.v1") && first.includes("close-up is for looking only"), "a close-up keeps acting coordinates");
  assert.equal((first.match(/"role":"navigation"/gu) ?? []).length >= 3, true, "back, forward and reload ran as steps");
  const state = await app.call<{ tabs: Array<{ id: string; agent: boolean; url: string }> }>("state");
  const tab = state.tabs.find(t => t.agent); assert.ok(tab);
  assert.ok(tab.url.includes("page=2"), "next, back, forward and reload end on page two");
  stub.set([
    () => ({ name: "write_file", arguments: { path: "upload/sample.txt", content: "hello upload", create_parents: true } }),
    () => bridgeBrowser("browser_observe", { tab: tab.id }),
    act(r => [{ action: "upload", ref: ref(r, /button "Upload file" \[([^\]]+)\]/u), value: "upload/sample.txt" }]),
  ]);
  await send("Upload the sample.", true);
  writeFileSync(join(evidence, "tool-results-upload.json"), JSON.stringify(stub.results));
  const subject = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)})`;
  const log = await app.main<{ files: Array<{ name: string; size: number; text: string }> }>(`${subject}.view.webContents.executeJavaScript("log")`);
  assert.deepEqual(log.files.map(f => [f.name, f.text]), [["sample.txt", "hello upload"]], "the approved workspace file reaches the page's own input");
} finally { writeFileSync(join(evidence, "tool-results-final.json"), JSON.stringify(stub.results)); await app.stop(); }
