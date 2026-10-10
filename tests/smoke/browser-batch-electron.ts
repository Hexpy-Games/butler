// test-category: race
/** Continuous batches on the real App: keyboard steps at focus, chords, multi-click,
 * right click, held-path drags, wait, observe:true and the secure-focus guard. */
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, bridgeBrowser, latestBrowser } from "../support/browser-agent-stub";
import type { StubModelRequest } from "../support/native-app-server";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const stub = browserStub();
const app = await browserAgentApp(evidence, stub.handler, undefined, { stubReply: () => "Ready" });
type Geometry = { width: number; height: number; cssWidth: number; cssHeight: number };
// Canvas CSS origin is (40,200); points are passed in screenshot coordinates.
const at = (o: Record<string, unknown>, x: number, y: number) => {
  const g = o.image_geometry as Geometry; return [(40 + x) * g.width / g.cssWidth, (200 + y) * g.height / g.cssHeight];
};
const act = (steps: (o: Record<string, unknown>) => unknown[], observe = true) => (r: StubModelRequest) => {
  const o = latestBrowser(r, "obs");
  return bridgeBrowser("browser_act", { tab: o.tab, observation: o.obs, observe, steps: steps(o) });
};
const queryRef = (o: Record<string, unknown>) => {
  const ref = /textbox "Query" \[([^\]]+)\]/u.exec((o.untrusted_content as { text: string }).text)?.[1]; assert.ok(ref); return ref;
};
async function send(text: string) {
  const prior = await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general");
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text, client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async () => { const v = await app.gateway.api<{ latest_turn?: { id: string; state: string } }>("/session-view?session_id=general"); return v.latest_turn?.id !== prior.latest_turn?.id && v.latest_turn?.state === "delivered"; }, "batch turn delivered");
}
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access", language: "ko" }) });
  const content = readFileSync("packages/butler-agent/rust/crates/butler-e2e/fixtures/browser-route/controls.html", "utf8");
  stub.set([() => ({ name: "write_file", arguments: { path: "controls/index.html", content, create_parents: true } }),
    () => ({ name: "output_publish", arguments: { path: "controls", title: "Batch controls" } })]);
  await send("Publish controls fixture");
  const outputs = await app.gateway.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
  const artifact = outputs.artifacts.find(a => a.kind === "web"); assert.ok(artifact);
  const view = await app.gateway.api<{ url: string }>(`/outputs/${artifact.id}/view`); await app.call("open");
  stub.set([
    () => ({ name: "tool_describe", arguments: { ids: ["browser_open", "browser_observe", "browser_act"].map(n => `native:${n}`) } }),
    () => bridgeBrowser("browser_open", { url: view.url }),
    r => bridgeBrowser("browser_observe", { tab: latestBrowser(r, "tab").tab }),
    act(o => [{ action: "click", ref: queryRef(o) }, { action: "type", value: "hello" }, { action: "press", value: "Enter" }]),
    act(() => [{ action: "press", value: "Tab" }, { action: "type", value: "secret" }]),
    act(o => [{ action: "click", ref: queryRef(o) }, { action: "press", value: "Control+Z" }, { action: "wait", value: "100" }]),
    act(o => [{ action: "click", point: at(o, 100, 100), expect: "canvas", click_count: 2, modifiers: ["Shift"] },
      { action: "click", point: at(o, 120, 120), expect: "canvas", button: "right" }], false),
    act(o => [{ action: "drag", point: at(o, 100, 100), path: [at(o, 200, 50), at(o, 300, 150)], target_point: at(o, 400, 100), expect: "canvas" }]),
    act(() => [{ action: "press", value: "Hyper+Q" }]),
  ]);
  await send("Use the controls.");
  const results = JSON.stringify(stub.results);
  writeFileSync(join(evidence, "tool-results.json"), results);
  assert.deepEqual(stub.results.filter(r => r && typeof r === "object" && "stubFailure" in r), []);
  assert.ok(results.includes("secure_field"), "keyboard input never reaches a focused secure field");
  assert.ok(results.includes("next_step_index"), "an interrupted batch names where to continue");
  assert.ok(results.includes("invalid_key"), "an unknown chord is refused before dispatch");
  assert.ok(results.includes("changed no pixels"), "a canvas stroke that paints nothing is reported, not assumed");
  assert.ok((results.match(/butler\.browser-observation\.v1/gu) ?? []).length >= 5, "observe:true returns observations");
  const state = await app.call<{ tabs: Array<{ id: string; agent: boolean; inUse: boolean; busy: boolean }> }>("state");
  const tab = state.tabs.find(t => t.agent); assert.ok(tab); assert.equal(tab.inUse, false); assert.equal(tab.busy, false);
  const subject = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)})`;
  assert.equal(await app.main(`${subject}.holder`), "agent", "agent keyboard input is not a user takeover");
  type Log = { keys: Array<{ key: string; ctrl: boolean; trusted: boolean; target: string }>; submits: Array<{ q: string; pw: number; trusted: boolean }>;
    clicks: Array<{ type: string; detail?: number; shift: boolean; button?: number }>; strokes: Array<{ points: Array<{ x: number; y: number; buttons: number }> }>; menus: number };
  const log = await app.main<Log>(`${subject}.view.webContents.executeJavaScript("log")`);
  writeFileSync(join(evidence, "controls-log.json"), JSON.stringify(log, null, 2));
  assert.deepEqual(log.submits, [{ q: "hello", pw: 0, trusted: true }], "type then Enter submits the focused form once");
  assert.ok(log.keys.some(k => k.key === "Enter" && k.target === "q" && k.trusted));
  assert.ok(log.keys.some(k => k.key === "Tab" && k.target === "q"));
  assert.ok(log.keys.some(k => k.key.toLowerCase() === "z" && k.ctrl && k.target === "q"), "chords carry their modifiers");
  assert.ok(log.clicks.some(c => c.type === "dblclick" && c.shift), "click_count 2 with Shift is a modified double click");
  assert.equal(log.menus, 1, "right click opens the page context menu");
  const strokes = log.strokes.filter(s => s.points.length > 3); assert.equal(strokes.length, 1);
  const points = strokes[0]!.points;
  for (const [x, y] of [[100, 100], [200, 50], [300, 150], [400, 100]]) {
    assert.ok(points.some(p => Math.hypot(p.x - x!, p.y - y!) < 3), `held path passes through ${x},${y}`);
  }
  assert.ok(points.slice(0, -1).every(p => p.buttons === 1), "the button stays held along the path");
} finally { await app.stop(); }
