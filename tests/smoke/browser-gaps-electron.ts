// test-category: race
/** Real App: only layers that really receive the pointer cover a control;
 * observations say plainly when a batch cleared fields, changed nothing, or made
 * new options appear after typing; a batch that made no progress is not run again
 * from the same state; a canvas drag that edits an existing object is reported. */
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
const observation = (r: StubModelRequest) => latestBrowser(r, "obs");
const text = (r: StubModelRequest) => (observation(r).untrusted_content as { text: string }).text;
const ref = (r: StubModelRequest, label: string) => {
  const found = new RegExp(`(?:button|link|element|textbox) "${label}" \\[([^\\]]+)\\]`, "u").exec(text(r))?.[1];
  assert.ok(found, `${label} in ${text(r)}`); return found;
};
const canvasCenter = (r: StubModelRequest) => {
  const found = /\[[^\]]+\] center=\[(\d+),(\d+)\] expect="canvas"/u.exec(text(r));
  assert.ok(found, text(r)); return [Number(found[1]), Number(found[2])];
};
const act = (steps: (r: StubModelRequest) => unknown[]) => (r: StubModelRequest) => {
  const o = observation(r);
  return bridgeBrowser("browser_act", { tab: o.tab, observation: o.obs, observe: true, steps: steps(r) });
};
/** Each observation the stub saw, with its text and progress notes. */
type Seen = { obs: string; text: string; notes: string[]; raw: Record<string, unknown> };
const flatNotes = (...items: Seen[]) => items.flatMap(item => item.notes);
const seen: Seen[] = [];
const keep = <T,>(next: (r: StubModelRequest) => T) => (r: StubModelRequest): T => {
  const o = observation(r);
  if (!seen.some(item => item.obs === o.obs)) seen.push({ obs: String(o.obs), text: text(r), notes: ((o.progress as { notes?: string[] } | undefined)?.notes) ?? [], raw: o });
  return next(r);
};
let cx = 0, cy = 0;
const line = (item: Seen, label: string) => item.text.split("\n").find(row => row.includes(`"${label}" [`)) ?? "";
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "full_access", language: "ko" }) });
  const content = readFileSync("packages/butler-agent/rust/crates/butler-e2e/fixtures/browser-route/gaps.html", "utf8");
  stub.set([() => ({ name: "write_file", arguments: { path: "gaps/index.html", content, create_parents: true } }),
    () => ({ name: "output_publish", arguments: { path: "gaps", title: "Gaps" } })]);
  await send("Publish gaps fixture");
  const outputs = await app.gateway.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
  const artifact = outputs.artifacts.find(a => a.kind === "web"); assert.ok(artifact);
  const page = await app.gateway.api<{ url: string }>(`/outputs/${artifact.id}/view`); await app.call("open");
  stub.set([
    () => ({ name: "tool_describe", arguments: { ids: ["browser_open", "browser_observe", "browser_act"].map(n => `native:${n}`) } }),
    () => bridgeBrowser("browser_open", { url: page.url }),
    r => bridgeBrowser("browser_observe", { tab: latestBrowser(r, "tab").tab }),
    // Tool, stroke, then another tool: the stroke opens an inline aria-modal widget.
    keep(act(r => { [cx, cy] = canvasCenter(r); return [{ action: "click", ref: ref(r, "Rectangle") },
      { action: "drag", point: [cx - 60, cy - 40], target_point: [cx + 60, cy + 40], expect: "canvas" }, { action: "click", ref: ref(r, "Line") }]; })),
    keep(act(r => [{ action: "click", ref: ref(r, "Open blocker") }])),
    keep(act(r => [{ action: "click", ref: ref(r, "Close blocker") }])),
    keep(act(r => [{ action: "click", ref: ref(r, "Open modal") }])),
    keep(act(r => [{ action: "click", ref: ref(r, "Close modal") }])),
    keep(act(r => [{ action: "fill", ref: ref(r, "Place"), value: "Sta" }])),
    keep(act(r => [{ action: "click", ref: ref(r, "Directions") }])),
    keep(act(r => [{ action: "click", ref: ref(r, "Noop") }])),
    keep(act(r => [{ action: "click", ref: ref(r, "Noop") }])),
    keep(act(r => [{ action: "click", ref: ref(r, "Add one") }])),
    keep(act(r => [{ action: "click", ref: ref(r, "Add one") }])),
    keep(act(r => [{ action: "fill", ref: ref(r, "Place"), value: "Sta" }])),
    keep(act(r => [{ action: "click", ref: ref(r, "Directions") }])),
    keep(act(r => [{ action: "click", ref: ref(r, "Directions") }, { action: "click", ref: ref(r, "Directions") }])),
    keep(act(() => [{ action: "press", value: "Control+Z" }])),
    keep(act(() => [{ action: "press", value: "Control+Z" }])),
    // The drawn line stays selected; a drag from its end handle edits it.
    keep(act(() => [{ action: "drag", point: [cx + 60, cy + 40], target_point: [cx + 180, cy - 20], expect: "canvas" }])),
    keep(act(() => [{ action: "press", value: "Escape" }, { action: "drag", point: [cx + 180, cy - 20], target_point: [cx + 220, cy + 60], expect: "canvas" }])),
    keep(() => null),
  ]);
  await send("Use the page.");
  writeFileSync(join(evidence, "tool-results.json"), JSON.stringify(stub.results));
  writeFileSync(join(evidence, "observations.json"), JSON.stringify(seen, null, 1));
  assert.deepEqual(stub.results.filter(r => r && typeof r === "object" && "stubFailure" in r), []);
  const [first, drawn, blocked, unblocked, modal, closed, typed, reset, noop, added, addedAgain, retyped, , undoAgain, edited, drawnAgain] = seen;
  assert.ok(first && drawn && blocked && unblocked && modal && closed && typed && reset && noop && added && addedAgain && retyped && undoAgain && edited && drawnAgain, JSON.stringify(seen.map(s => s.obs)));
  for (const label of ["Rectangle", "Red", "HUD action", "Non-modal close"]) {
    assert.ok(line(first, label) && !line(first, label).includes("covered_by"), `${label} is not covered: ${line(first, label)}`);
  }
  assert.ok(!first.text.includes("Hidden dialog button") && !first.text.includes("Closed dialog button"), "hidden dialogs expose nothing");
  assert.ok(line(drawn, "Bold") && !line(drawn, "Line").includes("covered_by"), "an inline aria-modal widget blocks nothing");
  const page2 = await app.call<{ tabs: Array<{ id: string; agent: boolean }> }>("state");
  const tab = page2.tabs.find(t => t.agent); assert.ok(tab);
  const strokes = await app.main<{ strokes: number; edits: number }>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab.id)}).view.webContents.executeJavaScript("log")`);
  assert.deepEqual([strokes.strokes, strokes.edits], [2, 1], "two lines drawn, one edited from its end handle");
  assert.match(line(blocked, "Rectangle"), /covered_by/u, "a visible backdrop covers the toolbar");
  assert.ok(!line(unblocked, "Rectangle").includes("covered_by"), "closing the backdrop uncovers it");
  assert.match(line(modal, "Rectangle"), /covered_by/u, "a native modal dialog blocks the page");
  assert.ok(!line(closed, "Rectangle").includes("covered_by"), "closing the modal uncovers it");
  assert.ok(typed.notes.some(note => /3 new clickable options appeared right after typing into \[/u.test(note)), JSON.stringify(typed.notes));
  assert.ok(reset.notes.some(note => /cleared field 1 \[/u.test(note)), JSON.stringify(reset.notes));
  assert.ok(reset.notes.some(note => note.includes(`back to its state at ${closed.obs}`)), JSON.stringify(reset.notes));
  assert.deepEqual([unblocked.notes, closed.notes], [[], []], "dismissing a popup is not reported as lost progress");
  const results = JSON.stringify(stub.results);
  assert.match(results, /This same batch already ran from this same page state and changed nothing visible/u, "the second Noop was refused");
  assert.match(results, /This same batch already ran from this same page state and cleared field 1/u, "the second Directions (a new element, same target) was refused");
  assert.match(results, /The first 1 step of this batch already ran from this same page state/u, "a doubled Directions was refused too");
  assert.ok(!flatNotes(added, addedAgain, retyped).some(note => note.includes("changed nothing")), "a visible counter and retyping are progress");
  assert.ok(noop.notes.some(note => note.includes("changed nothing visible")), JSON.stringify(noop.notes));
  assert.ok(edited.notes.some(note => note.includes("likely edited or moved an existing object")), JSON.stringify(edited.notes));
  assert.ok(!drawnAgain.notes.some(note => note.includes("existing object")), JSON.stringify(drawnAgain.notes));
  assert.ok(!drawn.notes.some(note => note.includes("existing object")), "a first stroke on a blank canvas edits nothing");
  assert.equal(Object.keys(edited.raw).filter(key => key !== "tool_name")[0], "progress", "notes lead the page data");
  assert.deepEqual(first.notes, [], "a first observation has nothing to compare");
  assert.deepEqual(undoAgain?.notes, [], "repeated keys may change pixels the DOM cannot see; no loop or no-change note");
  assert.ok(!drawn.notes.some(note => note.includes("changed nothing")), "canvas strokes are never judged by the DOM");
} finally { writeFileSync(join(evidence, "tool-results-final.json"), JSON.stringify(stub.results)); await app.stop(); }
