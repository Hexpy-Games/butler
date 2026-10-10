import { pendingDialog } from "./dialogs.mjs";
import { stepStill } from "./stills.mjs";
import { resolveStep, selectStep, selectTextStep } from "./observe.mjs";
import { dragTarget, dispatchDrag } from "./drag.mjs";
import { resolvePoint } from "./point.mjs";

async function resolveAction(tab, args, step, scroll = false) {
  const target = step.point ? await resolvePoint(tab, args.observation, step.point, step.expect)
    : await resolveStep(tab, args.observation, step, scroll);
  if (!target.reason && step.action === "drag" && step.target_point) {
    const destination = await resolvePoint(tab, args.observation, step.target_point, step.target_expect ?? step.expect);
    return destination.reason ? destination : { ...target, destination, payment: target.payment || destination.payment,
      frame_payment: target.frame_payment || destination.frame_payment, upload: target.upload || destination.upload, submit: target.submit || destination.submit };
  }
  return !target.reason && step.action === "drag" ? dragTarget(tab, args.observation, step, target, scroll) : target;
}

export async function prepareBatch(tab, args) {
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 10) return { status: "refused", reason: "invalid_steps",
    recovery: "Send 1–10 steps per call. Split tool/color selection from strokes: select, observe fresh pixels, then draw a group of strokes. No steps were dispatched." };
  if (args.steps.length > 1 && args.steps.some(step => step.action === "fill" && tab.observation?.nodes.some(node =>
    node.ref === step.ref && (node.role === "combobox" || ["list", "both"].includes(node.autocomplete))))) {
    return { status: "refused", reason: "autocomplete_requires_observation", recovery: "Fill one field, observe its suggestions, select one, then observe before the next action." };
  }
  const steps = [];
  for (const step of args.steps) {
    if (Boolean(step.ref) === Boolean(step.point) || !["click", "fill", "select", "scroll", "hover", "drag"].includes(step.action) || step.point && !["click", "scroll", "hover", "drag"].includes(step.action)) return { status: "refused", reason: "invalid_step",
      recovery: "Each step must use exactly one of ref or point, never both. For screenshot canvas drags omit ref; use action drag, point, target_point and expect canvas. Supported actions: click, fill, select, scroll, hover, drag; fill/select require ref." };
    const target = await resolveAction(tab, args, step);
    if (target.reason) return { status: "refused", ...target };
    steps.push({ ...target, action: step.action, value_preview: typeof step.value === "string" ? [...step.value].slice(0, 40).join("") : undefined });
  }
  return { status: "ok", tab: tab.id, epoch: tab.epoch, obs: args.observation, url: tab.url, steps };
}
function sameTarget(prepared, current) {
  return prepared && JSON.stringify(prepared.hit) === JSON.stringify(current.hit) && JSON.stringify(prepared.destination) === JSON.stringify(current.destination) && prepared.frame_payment === current.frame_payment && prepared.payment === current.payment && prepared.upload === current.upload && prepared.submit === current.submit && JSON.stringify(prepared.addons) === JSON.stringify(current.addons);
}
async function dispatch(tab, args, step, target) {
  const contents = tab.view.webContents;
  tab.dispatching = true;
  try {
    tab.onPointer?.(step, target);
    if (step.action === "drag") return await dispatchDrag(tab, target);
    const scale = tab.bounds?.scale ?? 1;
    const point = { x: Math.round(target.x * scale), y: Math.round(target.y * scale) };
    tab.expectedInputs = ["mouseMove", "mouseDown", "mouseUp", "mouseWheel"].map(type => ({ type, ...point }));
    if (step.action === "select") return await selectStep(tab, args.observation, step);
    contents.sendInputEvent({ type: "mouseMove", ...point });
    if (step.action === "scroll") contents.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY: -Number(step.value), canScroll: true });
    if (["click", "fill"].includes(step.action)) {
      contents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    }
    if (step.action === "fill") {
      await selectTextStep(tab, args.observation, step);
      await contents.insertText(String(step.value ?? ""));
    }
    // Yield so user input, ownership changes and navigation fence the next step.
    await new Promise(resolve => setTimeout(resolve, 0));
    return { status: "completed", hit: target.hit };
  } finally { tab.dispatching = false; tab.expectedInputs = []; }
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
      const target = await resolveAction(tab, args, step, true);
      if (target.reason) { steps.push({ status: "not_dispatched", ...target }); failed = true; continue; }
      if (!sameTarget(args.prepared_steps?.[index], target)) { steps.push({ status: "not_dispatched", reason: "approval_target_changed" }); failed = true; continue; }
      if (Date.now() >= deadline || tab.cancelled || tab.epoch !== epoch || tab.holder !== "agent" || tab.owner !== `conversation:${session}`) { steps.push({ status: "not_dispatched", reason: tab.owner !== `conversation:${session}` ? "owner_changed" : "control_changed" }); failed = true; continue; }
      steps.push(await dispatch(tab, args, step, target));
      if (tab.dialog) { steps[steps.length-1] = { status:"unknown", reason:"dialog_pending", hit:target.hit }; failed=true; }
      else if (steps.at(-1).status === "completed" && tab.epoch === epoch && tab.holder === "agent") {
        steps.at(-1).still = await stepStill(tab);
        if(tab.dialog) {steps[steps.length-1]={ status:"unknown", reason:"dialog_pending", hit:target.hit };failed=true;}
      }
    } catch { steps[index] = { status: "unknown", reason: "dispatch_interrupted" }; failed = true; }
  }
  if (tab.dialog) { tab.pendingBatch=steps; return { ...pendingDialog(tab), steps }; }
  return { status: steps.some(step => step.status === "unknown") ? "unknown" : failed ? "interrupted" : "ok", tab: tab.id, steps, url: tab.url, epoch: tab.epoch };
}
