// Runs with the same isolated-world perception helpers as ref resolution.
export function pointHit({ x, y, expect }) {
  globalThis.__butlerPerceptionCache = { styles: new WeakMap(), paint: new WeakMap(), clips: new WeakMap(), boxes: new WeakMap(), rectangles: new WeakMap(), luminances: new Map() };
  let element = hitAt(document, x, y);
  if (!element) return { reason: "point_mismatch" };
  element = actionableTarget(element);
  const box = rectangle(element), meaning = semantic(element);
  // What the point reached, so a refusal can say so: role, name, class words and rect.
  // A non-control is described by its tag and visible text.
  const hit = { role: meaning.role ?? element.localName, name: meaning.name ?? [...visibleLabel(element)].slice(0, 60).join(""), frame: location.hostname, class_words: classWords(element),
    rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } };
  if (meaning.secure) return { reason: "secure_field", hit };
  const hidden = rendering(element);
  if (hidden) return { reason: hidden === "invisible" ? "transparent_overlay" : "not_actionable", hit };
  if (element.disabled || element.getAttribute("aria-disabled") === "true") return { reason: "disabled", hit };
  for (const [ref, weak] of globalThis.__butlerObservation.refs) if (weak.deref() === element) { hit.ref = ref; break; }
  const words = expect.toLowerCase().trim().split(/\s+/u), role = words.shift();
  if (role !== meaning.role || meaning.role !== "canvas" && !words.every(word => meaning.name?.toLowerCase().includes(word))) return { reason: "point_mismatch", hit,
    recovery: meaning.role === "canvas" ? "This point hit a canvas, not the expected control. Use the control's current ref or its Graphical targets screenshot center. No steps were dispatched." : hit.ref ? "The point hit a different semantic target. Inspect its role/name and the fresh screenshot; use hit.ref if it is the intended control. Otherwise choose a corrected point." : "No observed control matched this point. Observe again, then choose a visible ref or a point within the intended target." };
  if (!meaning.clickable) return { reason: "not_actionable", hit };
  const rect = rectangle(element);
  return { x, y, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hit,
    verification: meaning.role === "canvas" ? "unverified" : "verified",
    payment: Boolean(element.closest("form")?.querySelector('[autocomplete="cc-number"],[autocomplete="cc-csc"]')),
    upload: element.localName === "input" && element.type === "file",
    submit: element.type === "submit" || /결제|구매|pay|purchase|checkout/iu.test(meaning.name), addons: currentAddons() };
}
