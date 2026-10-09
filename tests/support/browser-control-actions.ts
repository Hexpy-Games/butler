import { strict as assert } from "node:assert";
import type { redesignApp } from "./browser-redesign-app";

export type ControlApp = Awaited<ReturnType<typeof redesignApp>>;
/** Real gateway prepare/act frames and native receipts, no raw eval tool or real model. */
export async function pointerAction(app: ControlApp, tab: string, action: string, batch = false) {
  // Listing flushes the native hand-back projection before an agent action.
  await app.internal("tabs.list");
  const observation = await app.internal("tab.observe", tab);
  assert.equal(observation.status, "ok", JSON.stringify(observation));
  const target = observation.nodes.find((node: { role: string; name: string }) => action === "fill" ? node.role === "textbox" : node.role === "button" && node.name === "Confirm");
  assert.ok(target, JSON.stringify(observation.nodes));
  const steps = [{ action, ref: target.ref, ...(action === "fill" ? { value: "Fixture note" } : action === "scroll" ? { value: 150 } : {}) }];
  if (batch) steps.push({ action: "click", ref: target.ref });
  const args = { observation: observation.obs, steps };
  const prepared = await app.internal("tab.prepare", tab, args); assert.equal(prepared.status, "ok", JSON.stringify({ action, batch, prepared }));
  const result = await app.internal("tab.act", tab, { ...args, prepared_steps: prepared.steps });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.steps.length, steps.length); assert.ok(result.steps.every((step: { status: string }) => step.status === "completed"));
  return result;
}

/** Hold one real native frame lookup; receipt still flows through the gateway. */
export async function holdObservation(app: ControlApp, tab: string) {
  await app.internal("tabs.list");
  const subject = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)})`;
  await app.main(`(()=>{const debug=${subject}.view.webContents.debugger,send=debug.sendCommand.bind(debug);debug.sendCommand=(method,...args)=>method==='Page.getFrameTree'?new Promise(resolve=>{debug.sendCommand=send;globalThis.matrixRelease=()=>send(method,...args).then(resolve)}):send(method,...args)})()`);
  const pending = app.internal("tab.observe", tab);
  await waitForHold();
  async function waitForHold() {
    const { waitBrowser } = await import("./browser-agent-app");
    await waitBrowser(() => app.main("Boolean(globalThis.matrixRelease)"), "native frame lookup held");
  }
  return async () => {
    await app.main("(()=>{globalThis.matrixRelease();delete globalThis.matrixRelease})()");
    const result = await pending; assert.equal(result.status, "ok", JSON.stringify(result));
  };
}
