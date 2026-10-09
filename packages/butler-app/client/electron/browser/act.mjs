import { stepStill } from "./stills.mjs";
import { resolveStep, selectStep, selectTextStep } from "./observe.mjs";

export async function prepareBatch(tab, args) {
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 10) return { status: "refused", reason: "invalid_steps" };
  const steps = [];
  for (const step of args.steps) {
    if (!step.ref || !["click", "fill", "select", "scroll", "hover"].includes(step.action)) return { status: "refused", reason: "invalid_step" };
    const target = await resolveStep(tab, args.observation, step);
    if (target.reason) return { status: "refused", reason: target.reason, hit: target.hit };
    steps.push({ ...target, action: step.action, value_preview: typeof step.value === "string" ? [...step.value].slice(0, 40).join("") : undefined });
  }
  return { status: "ok", tab: tab.id, epoch: tab.epoch, obs: args.observation, url: tab.url, steps };
}
function sameTarget(prepared, current) {
  return prepared && JSON.stringify(prepared.hit) === JSON.stringify(current.hit) && prepared.frame_payment === current.frame_payment && prepared.payment === current.payment && prepared.upload === current.upload && prepared.submit === current.submit && JSON.stringify(prepared.addons) === JSON.stringify(current.addons);
}
async function dispatch(tab, args, step, target) {
  const contents = tab.view.webContents;
  tab.dispatching = true;
  try {
    const scale = tab.bounds?.scale ?? 1;
    const point = { x: Math.round(target.x * scale), y: Math.round(target.y * scale) };
    tab.expectedInputs = ["mouseMove", "mouseDown", "mouseUp", "mouseWheel"].map(type => ({ type, ...point }));
    if (step.action === "select") return await selectStep(tab, args.observation, step);
    contents.sendInputEvent({ type: "mouseMove", ...point });
    if (step.action === "scroll") contents.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY: Number(step.value), canScroll: true });
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
      steps.push({ status: "not_dispatched", reason: failed ? "previous_step_failed" : "control_changed" }); failed = true; continue;
    }
    try {
      const target = await resolveStep(tab, args.observation, step, true);
      if (target.reason) { steps.push({ status: "not_dispatched", reason: target.reason, hit: target.hit }); failed = true; continue; }
      if (!sameTarget(args.prepared_steps?.[index], target)) { steps.push({ status: "not_dispatched", reason: "approval_target_changed" }); failed = true; continue; }
      if (Date.now() >= deadline || tab.cancelled || tab.epoch !== epoch || tab.holder !== "agent" || tab.owner !== `conversation:${session}`) { steps.push({ status: "not_dispatched", reason: "control_changed" }); failed = true; continue; }
      steps.push(await dispatch(tab, args, step, target));
      if (tab.dialog) { steps[steps.length-1] = {status:"unknown",reason:"dialog_pending",hit:target.hit}; failed=true; }
      else if (steps.at(-1).status === "completed" && tab.epoch === epoch && tab.holder === "agent") {
        steps.at(-1).still = await stepStill(tab);
        if(tab.dialog) {steps[steps.length-1]={status:"unknown",reason:"dialog_pending",hit:target.hit};failed=true;}
      }
    } catch { steps[index] = { status: "unknown", reason: "dispatch_interrupted" }; failed = true; }
  }
  if (tab.dialog) { tab.pendingBatch=steps; return {status:"dialog_pending",tab:tab.id,url:tab.url,epoch:tab.epoch,dialog:tab.dialog,steps}; }
  return { status: steps.some(step => step.status === "unknown") ? "unknown" : failed ? "interrupted" : "ok", tab: tab.id, steps, url: tab.url, epoch: tab.epoch };
}
