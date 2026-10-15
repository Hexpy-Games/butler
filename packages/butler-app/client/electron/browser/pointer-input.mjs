const TYPES = new Map([
  ["mousedown", "mouseDown"], ["mouseup", "mouseUp"], ["mousemove", "mouseMove"],
  ["mouseenter", "mouseEnter"], ["mouseleave", "mouseLeave"], ["wheel", "mouseWheel"],
]);
const MOUSE = new Set(TYPES.values());
const BUTTONS = ["left", "middle", "right"];
const MODIFIERS = new Set(["shift", "control", "ctrl", "alt", "meta", "command", "cmd", "iskeypad", "isautorepeat", "leftbuttondown", "middlebuttondown", "rightbuttondown", "capslock", "numlock", "left", "right"]);

/** Project only the fields accepted by Electron. Metadata-only input-event
 * wheel/gesture notifications cannot supply coordinates or deltas; drop them. */
export function mouseInput(input) {
  const type = TYPES.get(input?.type) ?? input?.type;
  if (!MOUSE.has(type) || ![input.x, input.y].every(Number.isFinite)) return null;
  const modifiers = Array.isArray(input.modifiers) ? input.modifiers.filter(value => MODIFIERS.has(value)) : [];
  const button = BUTTONS.includes(input.button) ? input.button : "left";
  const result = { type, x: Math.round(input.x), y: Math.round(input.y), button,
    clickCount: Number.isInteger(input.clickCount) && input.clickCount > 0 ? input.clickCount : 1, modifiers };
  if (type === "mouseWheel") {
    if (![input.deltaX, input.deltaY].every(Number.isFinite)) return null;
    Object.assign(result, { deltaX: input.deltaX, deltaY: input.deltaY, canScroll: input.canScroll !== false });
    for (const key of ["wheelTicksX", "wheelTicksY", "accelerationRatioX", "accelerationRatioY"]) {
      if (Number.isFinite(input[key])) result[key] = input[key];
    }
    result.hasPreciseScrollingDeltas = input.hasPreciseScrollingDeltas === true;
  } else {
    for (const key of ["movementX", "movementY"]) if (Number.isFinite(input[key])) result[key] = input[key];
  }
  return result;
}
