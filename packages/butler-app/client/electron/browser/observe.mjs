import { closedRoots } from "./closed-roots.mjs";
import { randomUUID } from "node:crypto";
import { perceptionSource, resolveSource, selectSource } from "./page/snapshot.mjs";

async function evaluateFrame(tab, frame, code) {
  if (frame === tab.view.webContents.mainFrame && !tab.contexts?.has(frame.frameToken)) return tab.view.webContents.executeJavaScriptInIsolatedWorld(1004, [{ code }]);
  // Electron frame tokens are CDP frame IDs, including duplicate-URL subframes.
  const debuggerApi = tab.view.webContents.debugger;
  const executionContextId = tab.contexts?.get(frame.frameToken) ?? (await debuggerApi.sendCommand("Page.createIsolatedWorld", {
    frameId: frame.frameToken, worldName: "butler-browser",
  })).executionContextId;
  const result = await debuggerApi.sendCommand("Runtime.evaluate", { expression: code, contextId: executionContextId, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error("frame_unavailable");
  return result.result.value;
}
export async function observeTab(tab, args = {}) {
  const obs = randomUUID(), epoch = tab.epoch, frames = tab.view.webContents.mainFrame.framesInSubtree;
  const { frameTree } = await tab.view.webContents.debugger.sendCommand("Page.getFrameTree");
  tab.contexts = new Map();
  for (const frame of frames) {
    const context = await closedRoots(tab.view.webContents.debugger, frame.frameToken, frameTree.frame.id);
    if (context) tab.contexts.set(frame.frameToken, context);
  }
  const text = [], nodes = [], hidden = { invisible: 0, low_contrast: 0, tiny: 0 };
  const bindings = new Map(), paymentFrames = new Set();
  let scriptMs = 0, gridSampleMs = 0, below = 0, interactive = 0, payment = false;
  const addons = [];
  for (const [index, frame] of frames.entries()) {
    const result = await evaluateFrame(tab, frame, perceptionSource({ obs, epoch, scope: args.scope, prefix: `f${index}-` }));
    for (const node of result.nodes) { bindings.set(node.ref, frame); const { targetId: _targetId, coveredTargetId: _covered, ...publicNode } = node; nodes.push(publicNode); }
    if (result.payment) paymentFrames.add(frame);
    text.push(result.text);
    for (const key of Object.keys(hidden)) hidden[key] += result.hidden[key];
    scriptMs += result.scriptMs; gridSampleMs += result.gridSampleMs; below += result.totals.below_fold; interactive += result.totals.interactive;
    payment ||= result.payment; addons.push(...result.addons);
  }
  if (epoch !== tab.epoch || tab.holder !== "agent") return { status: "not_dispatched", reason: "user_control" };
  const full = `tab ${tab.id} epoch ${epoch} obs ${obs}\n${text.join("\n")}\ninteractive ${interactive}/${interactive} · below fold ${below} · hidden ${JSON.stringify(hidden)}`;
  const maxChars = args.scope === "text" ? 32000 : 16000;
  if (Buffer.byteLength(full) > maxChars) return { status: "refused", reason: "observation_budget_exceeded", totals: { interactive, below_fold: below } };
  tab.observation = { obs, epoch, bindings, nodes, payment, paymentFrames, addons };
  return { status: "ok", tab: tab.id, obs, epoch, url: tab.url, frames: frames.map(frame => frame.url).filter(url => url !== "about:blank"), text: full, nodes, hidden, totals: { interactive, below_fold: below }, cursor: null, scriptMs, gridSampleMs, payment, addons };
}
export async function resolveStep(tab, obs, step, scroll = false) {
  if (!tab.observation || tab.observation.obs !== obs || tab.observation.epoch !== tab.epoch) return { reason: "stale_ref" };
  const frame = tab.observation.bindings.get(step.ref);
  const node = tab.observation.nodes.find(node => node.ref === step.ref);
  if (!frame || !node) return { reason: "stale_ref" };
  if (!node.actionable) return { reason: node.secure ? "secure_field" : "not_actionable" };
  const resolved = await evaluateFrame(tab, frame, resolveSource({ ref: step.ref, obs, epoch: tab.epoch, scroll }));
  if (frame !== tab.view.webContents.mainFrame && !resolved.reason) {
    const debuggerApi = tab.view.webContents.debugger;
    const frameId = frame.frameToken;
    const { backendNodeId } = await debuggerApi.sendCommand("DOM.getFrameOwner", { frameId });
    const { model } = await debuggerApi.sendCommand("DOM.getBoxModel", { backendNodeId });
    resolved.x += model.content[0]; resolved.y += model.content[1];
    const hit = await debuggerApi.sendCommand("DOM.getNodeForLocation", { x: Math.round(resolved.x), y: Math.round(resolved.y), includeUserAgentShadowDOM: true });
    if (hit.frameId !== frameId) return { reason: "blocked_by" };
  }
  return { ...resolved, frame_payment: frame !== tab.view.webContents.mainFrame && tab.observation.paymentFrames.has(frame), payment: resolved.payment || tab.observation.payment, addons: tab.observation.addons };
}
export function selectStep(tab, obs, step) {
  return evaluateFrame(tab, tab.observation.bindings.get(step.ref), selectSource({ ref: step.ref, obs, epoch: tab.epoch, value: step.value }));
}

export function selectTextStep(tab, obs, step) {
  const code = `globalThis.__butlerObservation.refs.get(${JSON.stringify(step.ref)}).deref().select()`;
  return evaluateFrame(tab, tab.observation.bindings.get(step.ref), code);
}
