import { evaluateWorld } from "./frame-worlds.mjs";

const NAMED = new Map(Object.entries({
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", del: "Delete",
  insert: "Insert", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", space: "Space", spacebar: "Space",
  arrowup: "Up", up: "Up", arrowdown: "Down", down: "Down", arrowleft: "Left", left: "Left", arrowright: "Right", right: "Right", plus: "Plus",
}));
const MODIFIERS = new Map(Object.entries({ shift: "shift", control: "control", ctrl: "control", alt: "alt", option: "alt", meta: "meta", cmd: "meta", command: "meta" }));
// Electron derives the char text from the key code (VKEY_RETURN is "\r").
const CHARACTERS = { Enter: "Enter", Tab: "Tab", Space: "Space", Plus: "+" };

/** "Enter", "Control+Z", "Shift+Tab", "a": one chord per step. */
export function parseChord(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 40) return null;
  const parts = value.trim() === "+" ? ["+"] : value.trim().split(/\+(?!$)/u);
  const key = parts.pop(), modifiers = [];
  for (const part of parts) {
    const modifier = MODIFIERS.get(part.trim().toLowerCase());
    if (!modifier || modifiers.includes(modifier)) return null;
    modifiers.push(modifier);
  }
  const named = NAMED.get(key.trim().toLowerCase()) ?? (/^f([1-9]|1[0-9]|2[0-4])$/iu.test(key.trim()) ? key.trim().toUpperCase() : undefined);
  if (named) return { keyCode: named, modifiers, char: modifiers.some(m => m !== "shift") ? undefined : CHARACTERS[named] };
  if ([...key].length !== 1) return null;
  // An upper-case key code implies Shift in Electron; a chord names its modifiers explicitly.
  const keyCode = modifiers.length && /^\p{Lu}$/u.test(key) ? key.toLowerCase() : key;
  return { keyCode, modifiers, char: modifiers.some(m => m !== "shift") ? undefined : modifiers.includes("shift") ? keyCode.toUpperCase() : key };
}

// Runs in each observed frame's isolated world with the perception helpers installed.
function focusTarget({ key }) {
  if (!document.hasFocus()) return null;
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (element && /^(iframe|frame)$/u.test(element.localName)) return null;
  if (!element || element === document.body || element === document.documentElement) return { hit: { role: "document", name: document.title, frame: location.hostname } };
  const meaning = semantic(element, false), hit = { role: meaning.role || element.localName, name: meaning.name ?? "", frame: location.hostname };
  for (const [ref, weak] of globalThis.__butlerObservation?.refs ?? []) if (weak.deref() === element) { hit.ref = ref; break; }
  if (meaning.secure || secureKeypad(element) || element.type === "password") return { reason: "secure_field", hit };
  const form = element.form ?? element.closest("form");
  return { hit, payment: Boolean(form?.querySelector('[autocomplete="cc-number"],[autocomplete="cc-csc"]')),
    upload: element.localName === "input" && element.type === "file" && /^(Enter|Space)$/u.test(key ?? ""),
    submit: key === "Enter" && Boolean(form) || element.type === "submit" && /^(Enter|Space)$/u.test(key ?? "") };
}

/** The element that receives keyboard input now; the same frame-grant rule as points. */
export async function resolveFocus(tab, obs, key) {
  const observation = tab.observation;
  if (!observation || observation.obs !== obs || observation.epoch !== tab.epoch) return { reason: "stale_ref" };
  // The main frame names its focused element unless an iframe holds focus.
  for (const frame of observation.frames) {
    const result = await evaluateWorld(frame, `(${focusTarget.toString()})(${JSON.stringify({ key })})`).catch(() => null);
    if (!result) continue;
    if (frame.parent && new URL(frame.url).origin !== new URL(observation.main.url).origin) return { reason: "frame_not_granted", hit: result.hit };
    if (result.reason) return result;
    return { ...result, keyboard: true, payment: result.payment || observation.payment, frame_payment: Boolean(frame.parent) && observation.paymentFrames.has(frame), addons: [] };
  }
  return { keyboard: true, hit: { role: "document", name: "", frame: new URL(observation.main.url).hostname }, payment: false, upload: false, submit: false, addons: [] };
}

export async function dispatchKey(tab, chord) {
  const contents = tab.view.webContents;
  tab.expectedInputs = ["rawKeyDown", "keyDown", "char", "keyUp"].map(type => ({ type }));
  contents.sendInputEvent({ type: "keyDown", keyCode: chord.keyCode, modifiers: chord.modifiers });
  if (chord.char) contents.sendInputEvent({ type: "char", keyCode: chord.char, modifiers: chord.modifiers });
  contents.sendInputEvent({ type: "keyUp", keyCode: chord.keyCode, modifiers: chord.modifiers });
}
