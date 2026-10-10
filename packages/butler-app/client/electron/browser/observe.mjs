import { frameWorlds, evaluateWorld, hitFrame, framePoint } from "./frame-worlds.mjs";
import { perceptionSource, resolveSource, selectSource } from "./page/snapshot.mjs";
import { accessibleName, nameObservation } from "./accessibility.mjs";
import { contentRegions } from "./layout.mjs";
import { observationImage } from "./capture.mjs";

function editableFields(nodes) {
  return nodes.filter(node => !node.secure && node.value !== undefined)
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}
function fieldText(fields) {
  if (!fields.length) return "";
  return `Visible editable fields, top to bottom (${fields.length}):\n${fields.map((node, index) =>
    `${index + 1}. ${node.role} ${JSON.stringify(node.name)} [${node.ref}] value=${JSON.stringify(node.value)}${node.coveredBy ? ` covered_by ${node.coveredBy}` : ""}${!node.actionable ? " not actionable" : ""}`).join("\n")}`;
}
async function blockerInfo(tab, node) {
  const frame = tab.observation.bindings.get(node.ref);
  const value = await evaluateWorld(frame, `(()=>{const state=globalThis.__butlerObservation,element=state.refs.get(${JSON.stringify(node.coveredBy)})?.deref();
    if(!element?.isConnected)return {refs:[]};
    return {role:element.getAttribute('role')||element.localName,refs:[...state.refs].filter(([,weak])=>{const child=weak.deref();return child&&element.contains(child)}).map(([ref])=>ref)}})()`);
  const controls = tab.observation.nodes.filter(candidate => value.refs.includes(candidate.ref) && candidate.actionable)
    .map(candidate => ({ ref: candidate.ref, role: candidate.role, name: candidate.name }));
  return { ref: node.coveredBy, role: value.role, controls };
}

async function graphicalPoints(observation) {
  const geometry = observation.imageGeometry;
  if (!geometry) return "";
  const nodes = observation.nodes.filter(node => node.actionable && /^icon \d+×\d+ at /u.test(node.name));
  const origins = new Map();
  for (const frame of new Set(nodes.map(node => observation.bindings.get(node.ref)))) origins.set(frame, await framePoint(frame, { x: 0, y: 0 }));
  return nodes.length ? `Graphical targets in screenshot coordinates (ref or point, never both):\n${nodes.map(node => {
    const origin = origins.get(observation.bindings.get(node.ref)), r = node.rect;
    const x = Math.round((origin.x + r.x + r.width / 2) * geometry.width / geometry.cssWidth);
    const y = Math.round((origin.y + r.y + r.height / 2) * geometry.height / geometry.cssHeight);
    const left = Math.ceil((origin.x + r.x) * geometry.width / geometry.cssWidth), top = Math.ceil((origin.y + r.y) * geometry.height / geometry.cssHeight);
    const right = Math.floor((origin.x + r.x + r.width) * geometry.width / geometry.cssWidth), bottom = Math.floor((origin.y + r.y + r.height) * geometry.height / geometry.cssHeight);
    const bounds = node.role === "canvas" ? ` canvas screenshot bounds=[${left},${top},${right-left},${bottom-top}] (x,y,width,height); drag endpoints require ${left}<=x<${right}, ${top}<=y<${bottom}` : "";
    return `[${node.ref}] center=[${x},${y}] expect=${JSON.stringify(node.role === "canvas" ? "canvas" : `${node.role} icon`)}${bounds}`;
  }).join("\n")}` : "";
}

function observationBudget(args, interactive, below) {
  return { status: "refused", reason: "observation_budget_exceeded", totals: { interactive, below_fold: below },
    recovery: args.scope === "text"
      ? "Observe one returned frame at a time. No complete observation was returned; do not act or capture with an older observation."
      : "Observe again with scope=\"text\" to retain the complete controls and screenshot within the existing text budget. Inspect any open dialog and close it by its fresh ref before drawing or capturing. Do not reuse the older observation." };
}

// A navigation during observation is page state, not a user takeover.
function changed(tab) {
  return tab.holder !== "agent" ? { status: "not_dispatched", reason: "user_control" }
    : { status: "not_dispatched", reason: "page_changed", recovery: "The page navigated while it was observed. Observe again; no action was taken." };
}
// Resolves after the main document has had no DOM mutation for quietMs, or at maxMs.
const quiet = (quietMs, maxMs) => `new Promise(done=>{let timer;const end=()=>{observer.disconnect();clearTimeout(cap);done(true)};
  const observer=new MutationObserver(()=>{clearTimeout(timer);timer=setTimeout(end,${quietMs})});
  observer.observe(document,{subtree:true,childList:true,attributes:true,characterData:true});
  timer=setTimeout(end,${quietMs});const cap=setTimeout(end,${maxMs})})`;
/** After an action, wait briefly for loading and DOM updates (suggestions, recalculated results) to settle. */
async function settle(tab, maxMs = 2000) {
  const deadline = Date.now() + maxMs, contents = tab.view.webContents;
  while (contents.isLoading() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const remaining = deadline - Date.now();
  if (remaining > 0) await contents.executeJavaScriptInIsolatedWorld(9001, [{ code: quiet(300, remaining) }]).catch(() => {});
}
/** Retries an observation that a load-time navigation interrupted. */
export async function observeTab(tab, args = {}) {
  if (args.settle === true) await settle(tab);
  for (let attempt = 0; ; attempt++) {
    const result = await observeOnce(tab, args);
    if (result.reason !== "page_changed" || attempt === 2) return result;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}
async function observeOnce(tab, args) {
  // Per-tab sequence: unique for staleness checks and short enough to copy.
  const obs = `o${tab.observationSeq = (tab.observationSeq ?? 0) + 1}`, epoch = tab.epoch, frames = await frameWorlds(tab);
  const selected=frames.map((frame, index)=>({ frame, index })).filter(({ index })=>args.frame===undefined || args.frame===`f${index}`);
  if(!selected.length) return { status:"refused", reason:"frame_unavailable" };
  const text = [], nodes = [], fields = [], regions = [], hidden = { invisible: 0, low_contrast: 0, tiny: 0 };
  const bindings = new Map(), paymentFrames = new Set();
  let scriptMs = 0, gridSampleMs = 0, below = 0, interactive = 0, payment = false;
  const addons = [];
  for (const { index, frame } of selected) {
    const result = await evaluateWorld(frame, perceptionSource({ obs, epoch, scope: args.scope, secureKeypads: tab.policy?.secure_keypads ?? args.policy?.secure_keypads ?? [], prefix: `f${index}-` }));
    await nameObservation(tab, frame, result);
    if (result.layout_regions.length) {
      const origin = await framePoint(frame, { x: 0, y: 0 });
      regions.push(...result.layout_regions.map(region => ({ ...region, frame: `f${index}`,
        rect: { ...region.rect, x: region.rect.x + origin.x, y: region.rect.y + origin.y } })));
    }
    for (const node of result.nodes) { bindings.set(node.ref, frame); const { targetId: _targetId, coveredTargetId: _covered, ...publicNode } = node; nodes.push(publicNode); }
    if (result.payment) paymentFrames.add(frame);
    const inputs = editableFields(result.nodes);
    fields.push(...inputs.map((node, position) => ({ ref: node.ref, frame: `f${index}`, position: position + 1,
      role: node.role, name: node.name, value: node.value, actionable: node.actionable, covered_by: node.coveredBy })));
    text.push([fieldText(inputs), result.text].filter(Boolean).join("\n"));
    for (const key of Object.keys(hidden)) hidden[key] += result.hidden[key];
    scriptMs += result.scriptMs; gridSampleMs += result.gridSampleMs; below += result.totals.below_fold; interactive += result.totals.interactive;
    payment ||= result.payment; addons.push(...result.addons);
  }
  if (epoch !== tab.epoch || tab.holder !== "agent") return changed(tab);
  const full = `tab ${tab.id} epoch ${epoch} obs ${obs}\nNode rects and icon positions are CSS coordinates. Pointer points and capture_regions use screenshot coordinates; use image_geometry to convert.\n${text.join("\n")}\ninteractive ${interactive}/${interactive} · below fold ${below} · hidden ${JSON.stringify(hidden)}`;
  const maxChars = args.scope === "text" ? 32000 : 16000;
  if (Buffer.byteLength(full) > maxChars) return observationBudget(args, interactive, below);
  tab.observation = { obs, epoch, main:frames[0], frames, bindings, nodes, fields, payment, paymentFrames, addons, complete: selected.length === frames.length };
  const image = args.include_image ? await observationImage(tab) : {};
  if (args.include_image && !image.image) return { status: "refused", reason: image.image_status ?? "image_unavailable" };
  const pointText = await graphicalPoints(tab.observation);
  const observedText = [full, pointText].filter(Boolean).join("\n");
  if (epoch !== tab.epoch || tab.holder !== "agent") return changed(tab);
  if (Buffer.byteLength(observedText) > maxChars) return observationBudget(args, interactive, below);
  tab.observation.captureRegions = contentRegions(regions, tab.observation.imageGeometry);
  return { status: "ok", tab: tab.id, obs, epoch, url: tab.url, frames: selected.map(({ frame, index })=>({ id:`f${index}`, url:frame.url })), text: observedText, nodes, fields, layout_regions: regions, capture_regions: tab.observation.captureRegions, image_geometry: tab.observation.imageGeometry, hidden, totals: { interactive, below_fold: below }, cursor: null, scriptMs, gridSampleMs, payment, addons, ...image };
}
export async function resolveStep(tab, obs, step, scroll = false) {
  if (!tab.observation || tab.observation.obs !== obs || tab.observation.epoch !== tab.epoch) return { reason: "stale_ref" };
  const frame = tab.observation.bindings.get(step.ref);
  const node = tab.observation.nodes.find(node => node.ref === step.ref);
  if (!frame || !node) return { reason: "stale_ref" };
  if (!node.actionable) {
    if (node.secure) return { reason: "secure_field" };
    if (node.coveredBy) {
      return { reason: "blocked_by", blocker: await blockerInfo(tab, node),
        recovery: "Observe, select or dismiss the visible popup, then retry the field with a fresh ref." };
    }
    return { reason: "not_actionable" };
  }
  const resolved = await evaluateWorld(frame, resolveSource({ ref: step.ref, obs, epoch: tab.epoch, scroll, offset: step.pointOffset }));
  if (!resolved.reason && node.name_source === "accessibility") {
    const name = await accessibleName(tab, frame, step.ref);
    if (name) resolved.hit.name = name;
  }
  if (frame.parent && !resolved.reason) {
    const point=await hitFrame(frame, resolved);
    if(!point) return { reason:"blocked_by" };
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
