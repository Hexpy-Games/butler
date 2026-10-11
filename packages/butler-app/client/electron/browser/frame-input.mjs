/** Electron's sendInputEvent and insertText reach only the main frame's
 * renderer, so a cross-site (out-of-process) frame would see a click land on
 * its <iframe> element and never get keys or text. Input aimed into such a
 * frame goes through CDP instead: mouse events through the page session, which
 * routes them by hit test like real input, and keys and text through the
 * frame's own session. */
const REMOTE_FRAME = Symbol("remote frame");

/** Marks a resolved target whose frame runs in another renderer. A symbol key
 * survives object spreads and never reaches JSON results. */
export function routeTarget(target, frame) {
  if (frame?.sessionId) target[REMOTE_FRAME] = frame;
  return target;
}

const MOUSE = { mouseMove: "mouseMoved", mouseDown: "mousePressed", mouseUp: "mouseReleased", mouseWheel: "mouseWheel" };
const BITS = { alt: 1, control: 2, meta: 4, shift: 8 };
const bits = modifiers => (modifiers ?? []).reduce((sum, name) => sum | (BITS[name] ?? 0), 0);

/** The mouse sender for a target: Electron input for the main renderer, CDP for a remote frame. */
export function mouseSender(tab, target) {
  const contents = tab.view.webContents;
  if (!target?.[REMOTE_FRAME]) return async input => contents.sendInputEvent(input);
  return input => contents.debugger.sendCommand("Input.dispatchMouseEvent", {
    type: MOUSE[input.type], x: input.x, y: input.y, modifiers: bits(input.modifiers),
    button: ["mouseDown", "mouseUp"].includes(input.type) ? input.button ?? "left" : "none",
    clickCount: input.clickCount ?? 0,
    // Electron's wheel delta is positive upward; CDP's is positive downward.
    ...(input.type === "mouseWheel" ? { deltaX: -input.deltaX, deltaY: -input.deltaY } : {}),
  });
}

/** Inserts text at the focus, inside the remote frame that holds it if any. */
export function insertText(tab, target, text) {
  const frame = target?.[REMOTE_FRAME];
  return frame ? frame.api.sendCommand("Input.insertText", { text }) : tab.view.webContents.insertText(text);
}

const KEYS = {
  Enter: ["Enter", 13, "\r"], Tab: ["Tab", 9, "\t"], Escape: ["Escape", 27], Backspace: ["Backspace", 8], Delete: ["Delete", 46],
  Insert: ["Insert", 45], Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34], Space: [" ", 32, " "],
  Up: ["ArrowUp", 38], Down: ["ArrowDown", 40], Left: ["ArrowLeft", 37], Right: ["ArrowRight", 39], Plus: ["+", 187, "+"],
};
function keyOf(chord) {
  const named = KEYS[chord.keyCode] ?? (/^F\d+$/u.test(chord.keyCode) ? [chord.keyCode, 111 + Number(chord.keyCode.slice(1))] : null);
  if (named) return { key: named[0], code: named[1], text: chord.char === undefined ? undefined : named[2] };
  const key = chord.char ?? chord.keyCode;
  return { key, code: /^[a-z0-9]$/iu.test(chord.keyCode) ? chord.keyCode.toUpperCase().charCodeAt(0) : 0, text: chord.char };
}

/** Sends one parsed chord to a remote frame's focused element; false for the main renderer. */
export async function remoteKey(target, chord) {
  const frame = target?.[REMOTE_FRAME];
  if (!frame) return false;
  const { key, code, text } = keyOf(chord), modifiers = bits(chord.modifiers);
  const base = { key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers };
  await frame.api.sendCommand("Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", ...(text ? { text, unmodifiedText: text } : {}) });
  await frame.api.sendCommand("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  return true;
}
