import { pendingDialog } from "./dialogs.mjs";
import { stepStill } from "./stills.mjs";
import { resolveStep, selectStep, selectTextStep } from "./observe.mjs";
import { dragTarget, dispatchDrag } from "./drag.mjs";
import { resolvePoint } from "./point.mjs";
import { parseChord, resolveFocus, dispatchKey } from "./keyboard.mjs";
import { NAVIGATION, navigationTarget, dispatchNavigation, dispatchUpload } from "./navigate.mjs";
import { recordBatch, repeatRefusal, rememberRefusal, resentRefusal } from "./progress.mjs";
import { canvasBefore, canvasEffect } from "./canvas-effect.mjs";
import { insertText, mouseSender } from "./frame-input.mjs";

const POINTER = ["click", "fill", "select", "scroll", "hover", "drag", "upload"];
const ACTIONS = [...POINTER, "press", "type", "wait", ...NAVIGATION];
const MODIFIERS = { Shift: "shift", Control: "control", Alt: "alt", Meta: "meta" };
const STEP_HELP = "Pointer steps (click, fill, select, scroll, hover, drag) use exactly one of ref or point, never both; fill/select require ref. upload clicks the page's upload control (ref or point) with value = the workspace file. back, forward and reload take no target and end the batch. press, type and wait take no target: press sends one key or chord (\"Enter\", \"Escape\", \"Control+Z\") to the focused element, type inserts text at the focus, wait pauses 50–5000 ms. button and click_count apply to click; modifiers to click, drag and scroll; path only to a point drag. No steps were dispatched.";

function stepError(step) {
  const action = step?.action;
  if (!ACTIONS.includes(action)) return "invalid_step";
  if (POINTER.includes(action)) {
    if (Boolean(step.ref) === Boolean(step.point) || step.point && !["click", "scroll", "hover", "drag", "upload"].includes(action)) return "invalid_step";
  } else if (step.ref || step.point || step.target_ref || step.target_point) return "invalid_step";
  if (action === "press" && !parseChord(step.value)) return "invalid_key";
  if (action === "type" && (typeof step.value !== "string" || !step.value || step.value.length > 2000)) return "invalid_step";
  if (action === "upload" && (typeof step.value !== "string" || !step.value.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(step.value))) return "invalid_step";
  if (action === "wait" && !(Number(step.value) >= 50 && Number(step.value) <= 5000)) return "invalid_step";
  if (step.button !== undefined && (action !== "click" || !["left", "right", "middle"].includes(step.button))) return "invalid_step";
  if (step.click_count !== undefined && (action !== "click" || ![1, 2, 3].includes(step.click_count))) return "invalid_step";
  if (step.modifiers !== undefined && (!["click", "drag", "scroll"].includes(action) || !Array.isArray(step.modifiers) || step.modifiers.some(name => !MODIFIERS[name]))) return "invalid_step";
  if (step.path !== undefined && (action !== "drag" || !step.point || !step.target_point || !Array.isArray(step.path) || step.path.length > 24
    || step.path.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)))) return "invalid_step";
  return undefined;
}

async function resolvePath(tab, obs, step) {
  const path = [];
  for (const [index, point] of (step.path ?? []).entries()) {
    const hit = await resolvePoint(tab, obs, point, step.expect);
    if (hit.reason) return { ...hit, path_index: index, recovery: hit.recovery ?? "Every path point must hit the same surface as the drag start. Replan the path inside the observed bounds. No steps were dispatched." };
    path.push({ x: hit.x, y: hit.y });
  }
  return { path };
}

async function resolveAction(tab, args, step, scroll = false, afterInput = false) {
  if (step.action === "wait") return { hit: { role: "wait", name: "", frame: "" }, payment: false, upload: false, submit: false, frame_payment: false, addons: [] };
  if (NAVIGATION.includes(step.action)) return navigationTarget(tab, step.action);
  if (["press", "type"].includes(step.action)) {
    const key = step.action === "press" ? parseChord(step.value)?.keyCode : undefined;
    // An earlier step in this batch may move focus; the approval names that dependency.
    if (afterInput) return { keyboard: true, deferred: true, hit: { role: "focus", name: "", frame: "" }, payment: false, upload: false, submit: false, frame_payment: false, addons: [] };
    return resolveFocus(tab, args.observation, key);
  }
  const target = step.point ? await resolvePoint(tab, args.observation, step.point, step.expect)
    : await resolveStep(tab, args.observation, step, scroll);
  if (!target.reason && step.action === "drag" && step.target_point) {
    const destination = await resolvePoint(tab, args.observation, step.target_point, step.target_expect ?? step.expect);
    if (destination.reason) return destination;
    const path = await resolvePath(tab, args.observation, step);
    if (path.reason) return path;
    return { ...target, destination, path: path.path, payment: target.payment || destination.payment,
      frame_payment: target.frame_payment || destination.frame_payment, upload: target.upload || destination.upload, submit: target.submit || destination.submit };
  }
  // Every upload is always confirmed, whatever control opens the chooser.
  if (!target.reason && step.action === "upload") return { ...target, upload: true };
  return !target.reason && step.action === "drag" ? dragTarget(tab, args.observation, step, target, scroll) : target;
}

// Any earlier input step may move focus (a click, Tab, Enter); only wait cannot.
const afterInputStep = (steps, index) => steps.slice(0, index).some(step => step.action !== "wait");

export async function prepareBatch(tab, args) {
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 10) return { status: "refused", reason: "invalid_steps",
    recovery: "Send 1–10 steps per call. No steps were dispatched." };
  return resentRefusal(tab, args) ?? rememberRefusal(tab, args, await prepareSteps(tab, args));
}
async function prepareSteps(tab, args) {
  // Suggestions appear after an autocomplete fill, so nothing may follow it in
  // the batch; steps before it (e.g. clicking the field) are safe.
  if (args.steps.slice(0, -1).some(step => step.action === "fill" && tab.observation?.nodes.some(node =>
    node.ref === step.ref && (node.role === "combobox" || ["list", "both"].includes(node.autocomplete))))) {
    return { status: "refused", reason: "autocomplete_requires_observation", recovery: "An autocomplete fill must be the batch's last step: fill it (optionally after clicking it), observe its suggestions, select one, then continue. No steps were dispatched." };
  }
  const steps = [];
  for (const [index, step] of args.steps.entries()) {
    const error = stepError(step);
    if (error) return { status: "refused", reason: error, step_index: index, action: step?.action, recovery: STEP_HELP };
    if (NAVIGATION.includes(step.action) && index !== args.steps.length - 1) return { status: "refused", reason: "navigation_not_last", step_index: index, action: step.action, recovery: "back, forward and reload replace the page: send them as the batch's last step. No steps were dispatched." };
    const target = await resolveAction(tab, args, step, false, afterInputStep(args.steps, index));
    if (target.reason) return { status: "refused", step_index: steps.length, action: step.action, ...target };
    const value = step.action === "upload" ? step.value.split(/[\\/]/u).at(-1) : step.value;
    steps.push({ ...target, action: step.action, value_preview: typeof value === "string" ? [...value].slice(0, 40).join("") : undefined });
  }
  return repeatRefusal(tab, args, steps) ?? { status: "ok", tab: tab.id, epoch: tab.epoch, obs: args.observation, url: tab.url, profile: tab.profile, steps };
}
const sensitive = target => Boolean(target.payment && target.submit || target.upload || target.frame_payment);
function sameTarget(prepared, current) {
  // A focus-dependent step was approved as non-sensitive; anything sensitive needs its own approval.
  if (prepared?.deferred) return !sensitive(current);
  return prepared && JSON.stringify(prepared.hit) === JSON.stringify(current.hit) && JSON.stringify(prepared.destination) === JSON.stringify(current.destination) && prepared.frame_payment === current.frame_payment && prepared.payment === current.payment && prepared.upload === current.upload && prepared.submit === current.submit && JSON.stringify(prepared.addons) === JSON.stringify(current.addons);
}
function wheelDelta(value) {
  const parts = String(value ?? "").split(",").map(Number);
  return parts.length === 2 ? { deltaX: -parts[0], deltaY: -parts[1] } : { deltaX: 0, deltaY: -parts[0] };
}
async function dispatch(tab, args, step, target) {
  tab.dispatching = true;
  try {
    tab.onPointer?.(step, target);
    if (step.action === "wait") { await new Promise(resolve => setTimeout(resolve, Number(step.value))); return { status: "completed", hit: target.hit }; }
    if (step.action === "press") { await dispatchKey(tab, parseChord(step.value), target); await new Promise(resolve => setTimeout(resolve, 0)); return { status: "completed", hit: target.hit }; }
    if (step.action === "type") { tab.expectedInputs = []; await insertText(tab, target, step.value); return { status: "completed", hit: target.hit }; }
    if (NAVIGATION.includes(step.action)) { dispatchNavigation(tab, step.action); return { status: "completed", hit: target.hit }; }
    const modifiers = (step.modifiers ?? []).map(name => MODIFIERS[name]);
    if (step.action === "drag") return await dispatchDrag(tab, target, modifiers);
    const scale = tab.bounds?.scale ?? 1;
    const point = { x: Math.round(target.x * scale), y: Math.round(target.y * scale) };
    tab.expectedInputs = ["mouseMove", "mouseDown", "mouseUp", "mouseWheel"].map(type => ({ type, ...point }));
    if (step.action === "select") return await selectStep(tab, args.observation, step);
    const send = mouseSender(tab, target);
    const click = async () => {
      const button = step.button ?? "left";
      for (let count = 1; count <= (step.click_count ?? 1); count++) {
        await send({ type: "mouseDown", ...point, button, clickCount: count, modifiers });
        await send({ type: "mouseUp", ...point, button, clickCount: count, modifiers });
      }
    };
    await send({ type: "mouseMove", ...point });
    if (step.action === "upload") return { ...await dispatchUpload(tab, step.value, click), hit: target.hit };
    if (step.action === "scroll") await send({ type: "mouseWheel", ...point, ...wheelDelta(step.value), modifiers, canScroll: true });
    if (["click", "fill"].includes(step.action)) await click();
    if (step.action === "fill") {
      await selectTextStep(tab, args.observation, step);
      await insertText(tab, target, String(step.value ?? ""));
    }
    // Yield so user input, ownership changes and navigation fence the next step.
    await new Promise(resolve => setTimeout(resolve, 0));
    return { status: "completed", hit: target.hit };
  } finally { tab.dispatching = false; tab.expectedInputs = []; }
}

const RECOVERY = {
  control_changed: "The page navigated or re-rendered after the completed steps, so the observation expired. Completed steps took effect; never repeat them. Observe and continue with the remaining steps using fresh refs or points.",
  approval_target_changed: "An earlier step changed this step's target (focus or element moved, or it became sensitive). Completed steps took effect; never repeat them. Observe and send the remaining steps again; a keyboard step into a payment or upload control needs its own call.",
  stale_ref: "The observation expired after the completed steps. Completed steps took effect; never repeat them. Observe and continue with fresh refs.",
};
function batchResult(tab, steps, failed) {
  const completed = steps.filter(step => step.status === "completed").length;
  // Notes lead the result so they are read before the receipts.
  const notes = steps.flatMap((step, index) => step.canvas_effect ? [`Step ${index}: ${step.canvas_effect.note}`] : []);
  const result = { ...(notes.length ? { notes } : {}), status: steps.some(step => step.status === "unknown") ? "unknown" : failed ? "interrupted" : "ok", tab: tab.id, steps, url: tab.url, epoch: tab.epoch, completed };
  const first = steps.findIndex(step => step.status !== "completed");
  if (first >= 0 && result.status === "interrupted") {
    result.next_step_index = first;
    result.recovery = RECOVERY[steps[first].reason] ?? `Step ${first} was not dispatched (${steps[first].reason}). Completed steps took effect; never repeat them. Observe before continuing.`;
  }
  return result;
}
export async function actBatch(tab, args, session) {
  const epoch = tab.epoch, steps = [];
  let failed = false;
  const deadline = Date.now() + Math.min(Number(args.deadline_ms) || 30000, 30000);
  for (const [index, step] of (args.steps ?? []).entries()) {
    if (failed || Date.now() >= deadline || tab.cancelled || tab.owner !== `conversation:${session}` || tab.holder !== "agent" || tab.epoch !== epoch) {
      steps.push({ status: "not_dispatched", reason: tab.owner !== `conversation:${session}` ? "owner_changed" : failed ? "previous_step_failed" : "control_changed" }); failed = true; continue;
    }
    try {
      const prepared = args.prepared_steps?.[index];
      const target = prepared?.deferred ? await resolveFocus(tab, args.observation, step.action === "press" ? parseChord(step.value)?.keyCode : undefined)
        : await resolveAction(tab, args, step, true);
      if (target.reason) { steps.push({ status: "not_dispatched", ...target }); failed = true; continue; }
      if (!sameTarget(prepared, target)) { steps.push({ status: "not_dispatched", reason: "approval_target_changed" }); failed = true; continue; }
      if (Date.now() >= deadline || tab.cancelled || tab.epoch !== epoch || tab.holder !== "agent" || tab.owner !== `conversation:${session}`) { steps.push({ status: "not_dispatched", reason: tab.owner !== `conversation:${session}` ? "owner_changed" : "control_changed" }); failed = true; continue; }
      const before = step.action === "drag" ? await canvasBefore(tab, target) : null;
      steps.push(await dispatch(tab, args, step, target));
      if (before && steps.at(-1).status === "completed") {
        const effect = await canvasEffect(tab, before, target);
        if (effect) steps.at(-1).canvas_effect = effect;
      }
      if (tab.dialog) { steps[steps.length-1] = { status:"unknown", reason:"dialog_pending", hit:target.hit }; failed=true; }
      else if (steps.at(-1).status === "completed" && tab.epoch === epoch && tab.holder === "agent") {
        steps.at(-1).still = await stepStill(tab);
        if(tab.dialog) {steps[steps.length-1]={ status:"unknown", reason:"dialog_pending", hit:target.hit };failed=true;}
      }
    } catch { steps[index] = { status: "unknown", reason: "dispatch_interrupted" }; failed = true; }
  }
  recordBatch(tab, args, steps);
  if (tab.dialog) { tab.pendingBatch=steps; return { ...pendingDialog(tab), steps }; }
  return batchResult(tab, steps, failed);
}
