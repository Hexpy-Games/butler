import { frameWorlds, evaluateWorld, hitFrame } from "./frame-worlds.mjs";
import { randomUUID } from "node:crypto";
import { perceptionSource, resolveSource, selectSource } from "./page/snapshot.mjs";

export async function observeTab(tab, args = {}) {
  const obs = randomUUID(), epoch = tab.epoch, frames = await frameWorlds(tab);
  const selected=frames.map((frame,index)=>({frame,index})).filter(({index})=>args.frame===undefined || args.frame===`f${index}`);
  if(!selected.length) return {status:"refused",reason:"frame_unavailable"};
  const text = [], nodes = [], hidden = { invisible: 0, low_contrast: 0, tiny: 0 };
  const bindings = new Map(), paymentFrames = new Set();
  let scriptMs = 0, gridSampleMs = 0, below = 0, interactive = 0, payment = false;
  const addons = [];
  for (const {index,frame} of selected) {
    const result = await evaluateWorld(frame, perceptionSource({ obs, epoch, scope: args.scope, secureKeypads: tab.policy?.secure_keypads ?? args.policy?.secure_keypads ?? [], prefix: `f${index}-` }));
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
  tab.observation = { obs, epoch, main:frames[0], bindings, nodes, payment, paymentFrames, addons };
  return { status: "ok", tab: tab.id, obs, epoch, url: tab.url, frames: selected.map(({frame,index})=>({id:`f${index}`,url:frame.url})), text: full, nodes, hidden, totals: { interactive, below_fold: below }, cursor: null, scriptMs, gridSampleMs, payment, addons };
}
export async function resolveStep(tab, obs, step, scroll = false) {
  if (!tab.observation || tab.observation.obs !== obs || tab.observation.epoch !== tab.epoch) return { reason: "stale_ref" };
  const frame = tab.observation.bindings.get(step.ref);
  const node = tab.observation.nodes.find(node => node.ref === step.ref);
  if (!frame || !node) return { reason: "stale_ref" };
  if (!node.actionable) return { reason: node.secure ? "secure_field" : "not_actionable" };
  const resolved = await evaluateWorld(frame, resolveSource({ ref: step.ref, obs, epoch: tab.epoch, scroll }));
  if (frame.parent && !resolved.reason) {
    const point=await hitFrame(frame,resolved);
    if(!point) return {reason:"blocked_by"};
    if (resolved.rect) { resolved.rect.x += point.x - resolved.x; resolved.rect.y += point.y - resolved.y; }
    resolved.x=point.x;resolved.y=point.y;
  }
  return { ...resolved, frame_payment: Boolean(frame.parent) && tab.observation.paymentFrames.has(frame), payment: resolved.payment || tab.observation.payment, addons: resolved.addons ?? [] };
}
export function selectStep(tab, obs, step) {
  return evaluateWorld(tab.observation.bindings.get(step.ref), selectSource({ ref: step.ref, obs, epoch: tab.epoch, value: step.value }));
}

export function selectTextStep(tab, obs, step) {
  const code = `(async()=>{await new Promise(done=>requestAnimationFrame(done));const e=globalThis.__butlerObservation.refs.get(${JSON.stringify(step.ref)}).deref();if(e.isContentEditable){const range=document.createRange();range.selectNodeContents(e);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)}else e.select()})()`;
  return evaluateWorld(tab.observation.bindings.get(step.ref), code);
}
