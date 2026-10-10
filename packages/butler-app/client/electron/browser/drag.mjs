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

/** Native drag input shares the existing expected-input and overlay pointer path.
 * A point drag may pass through ordered path vertices with the button held. */
export async function dispatchDrag(tab, source, modifiers = []) {
  const contents = tab.view.webContents, scale = tab.bounds?.scale ?? 1;
  const point = target => ({ x: Math.round(target.x * scale), y: Math.round(target.y * scale) });
  const start = point(source), vertices = [...(source.path ?? []).map(point), point(source.destination)];
  let current = start;
  const epoch = tab.epoch, owner = tab.owner;
  const expected = at => { tab.expectedInputs = ["mouseMove", "mouseDown", "mouseUp"].map(type => ({ type, ...at })); };
  expected(start);
  contents.sendInputEvent({ type: "mouseMove", ...start, modifiers });
  contents.sendInputEvent({ type: "mouseDown", ...start, button: "left", clickCount: 1, modifiers });
  try {
    let from = start;
    for (const end of vertices) {
      // A straight drag keeps eight held moves; path segments scale with length.
      const moves = vertices.length === 1 ? 8 : Math.min(8, Math.max(2, Math.ceil(Math.hypot(end.x - from.x, end.y - from.y) / (12 * scale))));
      for (let n = 1; n <= moves; n++) {
        if (tab.cancelled || tab.holder !== "agent" || tab.epoch !== epoch || tab.owner !== owner) return { status: "unknown", reason: "control_changed" };
        const x = Math.round(from.x + (end.x - from.x) * n / moves), y = Math.round(from.y + (end.y - from.y) * n / moves);
        tab.onPointer?.({ action: "drag" }, { x: x / scale, y: y / scale, rect: source.destination.rect });
        expected({ x, y });
        current = { x, y };
        contents.sendInputEvent({ type: "mouseMove", x, y, button: "left", modifiers: ["leftButtonDown", ...modifiers] });
        // A zero-delay yield lets Chromium coalesce a whole stroke into one move.
        // Wait for an input frame so canvas apps receive the held-button path.
        await new Promise(done => setTimeout(done, 20));
      }
      from = end;
    }
    return { status: "completed", hit: source.hit, destination: source.destination.hit };
  } finally {
    if (!contents.isDestroyed()) { expected(current); contents.sendInputEvent({ type: "mouseUp", ...current, button: "left", clickCount: 1, modifiers }); }
  }
}
