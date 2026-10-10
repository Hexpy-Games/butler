import { resolveStep } from "./observe.mjs";

export async function dragTarget(tab, observation, step, source, scroll = false) {
  if (step.target_ref) {
    const destination = await resolveStep(tab, observation, { ref: step.target_ref }, scroll);
    if (destination.reason) return destination;
    return { ...source, destination, payment: source.payment || destination.payment,
      frame_payment: source.frame_payment || destination.frame_payment,
      upload: source.upload || destination.upload, submit: source.submit || destination.submit };
  }
  if (!Array.isArray(step.offset) || step.offset.length !== 2 || !step.offset.every(Number.isFinite)) return { reason: "invalid_drag" };
  const destination = await resolveStep(tab, observation, { ref: step.ref, pointOffset: step.offset }, scroll);
  if (destination.reason) return destination;
  return { ...source, destination };
}

/** Native drag input shares the existing expected-input and overlay pointer path. */
export async function dispatchDrag(tab, source) {
  const contents = tab.view.webContents, scale = tab.bounds?.scale ?? 1;
  const point = target => ({ x: Math.round(target.x * scale), y: Math.round(target.y * scale) });
  const start = point(source), end = point(source.destination);
  let current = start;
  const epoch = tab.epoch, owner = tab.owner;
  const expected = at => { tab.expectedInputs = ["mouseMove", "mouseDown", "mouseUp"].map(type => ({ type, ...at })); };
  expected(start);
  contents.sendInputEvent({ type: "mouseMove", ...start });
  contents.sendInputEvent({ type: "mouseDown", ...start, button: "left", clickCount: 1 });
  try {
    for (let n = 1; n <= 8; n++) {
      if (tab.cancelled || tab.holder !== "agent" || tab.epoch !== epoch || tab.owner !== owner) return { status: "unknown", reason: "control_changed" };
      const x = Math.round(start.x + (end.x - start.x) * n / 8), y = Math.round(start.y + (end.y - start.y) * n / 8);
      tab.onPointer?.({ action: "drag" }, { x: x / scale, y: y / scale, rect: source.destination.rect });
      expected({ x, y });
      current = { x, y };
      contents.sendInputEvent({ type: "mouseMove", x, y, button: "left", modifiers: ["leftButtonDown"] });
      // A zero-delay yield lets Chromium coalesce a whole stroke into one move.
      // Wait for an input frame so canvas apps receive the held-button path.
      await new Promise(done => setTimeout(done, 20));
    }
    return { status: "completed", hit: source.hit, destination: source.destination.hit };
  } finally {
    if (!contents.isDestroyed()) { expected(current); contents.sendInputEvent({ type: "mouseUp", ...current, button: "left", clickCount: 1 }); }
  }
}
