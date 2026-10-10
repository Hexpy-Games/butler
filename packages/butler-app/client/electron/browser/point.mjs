import { accessibleName } from "./accessibility.mjs";
import { evaluateWorld, framePoint, hitFrame } from "./frame-worlds.mjs";

// Runs with the same isolated-world perception helpers as ref resolution.
function pointHit({ x, y, expect }) {
  globalThis.__butlerPerceptionCache = { styles: new WeakMap(), paint: new WeakMap(), clips: new WeakMap(), boxes: new WeakMap(), rectangles: new WeakMap(), luminances: new Map() };
  let element = hitAt(document, x, y);
  if (!element) return { reason: "point_mismatch" };
  element = actionableTarget(element);
  const meaning = semantic(element), hit = { role: meaning.role, name: meaning.name, frame: location.hostname };
  if (meaning.secure) return { reason: "secure_field", hit };
  const hidden = rendering(element);
  if (hidden) return { reason: hidden === "invisible" ? "transparent_overlay" : "not_actionable", hit };
  if (element.disabled || element.getAttribute("aria-disabled") === "true") return { reason: "disabled", hit };
  for (const [ref, weak] of globalThis.__butlerObservation.refs) if (weak.deref() === element) { hit.ref = ref; break; }
  const words = expect.toLowerCase().trim().split(/\s+/u), role = words.shift();
  if (role !== meaning.role || meaning.role !== "canvas" && !words.every(word => meaning.name?.toLowerCase().includes(word))) return { reason: "point_mismatch", hit,
    recovery: meaning.role === "canvas" ? "This point hit the drawing canvas, not a toolbar/palette control. Use a current element ref or its Graphical targets screenshot center for a control. Do not use the canvas ref/center for tool or color selection. No steps were dispatched." : hit.ref ? "The point hit a different semantic target. Inspect its role/name and the fresh screenshot; use hit.ref if it is the intended control. Otherwise choose a corrected point. Palette graphics may be element icons, not the drawing canvas." : "No observed control matched this point. Observe again, then choose a visible ref or a point within the intended target." };
  if (!meaning.clickable) return { reason: "not_actionable", hit };
  const rect = rectangle(element);
  return { x, y, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, hit,
    verification: meaning.role === "canvas" ? "unverified" : "verified",
    payment: Boolean(element.closest("form")?.querySelector('[autocomplete="cc-number"],[autocomplete="cc-csc"]')),
    upload: element.localName === "input" && element.type === "file",
    submit: element.type === "submit" || /결제|구매|pay|purchase|checkout/iu.test(meaning.name), addons: currentAddons() };
}

export async function resolvePoint(tab, obs, point, expect) {
  const observation = tab.observation, image = observation?.imageGeometry;
  if (!observation || observation.obs !== obs || observation.epoch !== tab.epoch) return { reason: "stale_ref" };
  if (!image) return { reason: "vision_required" };
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || typeof expect !== "string" || !expect.trim()) return { reason: "invalid_point" };
  if (point[0] < 0 || point[1] < 0 || point[0] >= image.width || point[1] >= image.height) return { reason: "point_outside_viewport" };
  const css = { x: point[0] * image.cssWidth / image.width, y: point[1] * image.cssHeight / image.height };
  for (const frame of [...observation.frames].reverse()) {
    const origin = await framePoint(frame, { x: 0, y: 0 });
    const local = { x: css.x - origin.x, y: css.y - origin.y };
    if (!await hitFrame(frame, local)) continue;
    if (frame.parent && new URL(frame.url).origin !== new URL(observation.main.url).origin) return { reason: "frame_not_granted" };
    const result = await evaluateWorld(frame, `(${pointHit.toString()})(${JSON.stringify({ ...local, expect })})`);
    if (result.reason) return pointRefusal(observation, point, expect, result);
    if (observation.nodes.find(node => node.ref === result.hit.ref)?.name_source === "accessibility") {
      const name = await accessibleName(tab, frame, result.hit.ref);
      if (name) result.hit.name = name;
      if (!expect.toLowerCase().trim().split(/\s+/u).slice(1).every(word => result.hit.name.toLowerCase().includes(word))) return { reason: "point_mismatch", hit: result.hit };
    }
    return { ...result, ...css, rect: { ...result.rect, x: result.rect.x + origin.x, y: result.rect.y + origin.y },
      payment: result.payment || observation.payment, frame_payment: Boolean(frame.parent) && observation.paymentFrames.has(frame) };
  }
  return { reason: "blocked_by" };
}

function pointRefusal(observation, point, expect, result) {
  if (!["point_mismatch", "not_actionable"].includes(result.reason)) return result;
  const canvas = /^canvas(?:\s|$)/iu.test(expect);
  return { ...result, rejected_point: point, image_geometry: observation.imageGeometry,
    untrusted_content: { kind: "web_page_data", capture_regions: observation.captureRegions },
    recovery: canvas && !result.hit?.ref
      ? "This screenshot point does not hit the observed drawing canvas. No steps were dispatched; this is coordinate validation, not an input delivery failure. Observe fresh pixels, then keep both drag endpoints inside the canvas screenshot bounds/capture_regions. Tool and color selection are separate clicks."
      : result.recovery };
}
