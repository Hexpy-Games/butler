import { accessibleName } from "./accessibility.mjs";
import { evaluateWorld, framePoint, hitFrame } from "./frame-worlds.mjs";
import { pointHit } from "./page/point.mjs";
import { frameClass, signedInPolicy, topSite } from "./signed-in.mjs";

/** Points into other-site frames: signed-in tabs follow decision 25, signed-out tabs keep same-origin only. */
function frameRefusal(tab, frame, main) {
  if (!frame.parent) return null;
  const policy = signedInPolicy(tab);
  if (!policy) return new URL(frame.url).origin !== new URL(main.url).origin ? { reason: "frame_not_granted" } : null;
  if (frameClass(frame.url, tab.url, policy) !== "unknown") return null;
  return { reason: "frame_grant_required", site: topSite(tab.url, policy), frame_site: new URL(frame.url).hostname };
}

export async function resolvePoint(tab, obs, point, expect) {
  const observation = tab.observation, image = observation?.imageGeometry;
  if (!observation || observation.obs !== obs || observation.epoch !== tab.epoch) return { reason: "stale_ref" };
  if (!image) return { reason: "vision_required" };
  if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) || typeof expect !== "string" || !expect.trim()) return { reason: "invalid_point" };
  if (point[0] < 0 || point[1] < 0 || point[0] >= image.width || point[1] >= image.height) return { reason: "point_outside_viewport" };
  const css = { x: point[0] * image.cssWidth / image.width, y: point[1] * image.cssHeight / image.height };
  for (const frame of [...observation.frames].reverse()) {
    // A hidden iframe has no layout box, so it cannot be where the point is.
    const origin = await framePoint(frame, { x: 0, y: 0 }).catch(() => null);
    if (!origin) continue;
    const local = { x: css.x - origin.x, y: css.y - origin.y };
    if (!await hitFrame(frame, local)) continue;
    const refused = frameRefusal(tab, frame, observation.main);
    if (refused) return refused;
    const result = await evaluateWorld(frame, `(${pointHit.toString()})(${JSON.stringify({ ...local, expect })})`);
    if (result.reason) return pointRefusal(observation, point, expect, result, origin);
    if (observation.nodes.find(node => node.ref === result.hit.ref)?.name_source === "accessibility") {
      const name = await accessibleName(tab, frame, result.hit.ref);
      if (name) result.hit.name = name;
      if (!expect.toLowerCase().trim().split(/\s+/u).slice(1).every(word => result.hit.name.toLowerCase().includes(word))) return pointRefusal(observation, point, expect, { reason: "point_mismatch", hit: result.hit }, origin);
    }
    return { ...result, ...css, rect: { ...result.rect, x: result.rect.x + origin.x, y: result.rect.y + origin.y },
      payment: result.payment || observation.payment, frame_payment: Boolean(frame.parent) && observation.paymentFrames.has(frame) };
  }
  return pointRefusal(observation, point, expect, { reason: "blocked_by" }, { x: 0, y: 0 });
}

/** The observed main-frame control closest to a screenshot point, with its center. */
function nearestControl(observation, point) {
  const image = observation.imageGeometry, sx = image.width / image.cssWidth, sy = image.height / image.cssHeight;
  let best = null;
  for (const node of observation.nodes) {
    if (!node.actionable || !node.rect || observation.bindings.get(node.ref) !== observation.main) continue;
    const left = node.rect.x * sx, top = node.rect.y * sy, right = left + node.rect.width * sx, bottom = top + node.rect.height * sy;
    const distance = Math.hypot(Math.max(left - point[0], 0, point[0] - right), Math.max(top - point[1], 0, point[1] - bottom));
    if (distance <= 80 && (!best || distance < best.distance)) best = { distance, node, center: [Math.round((left + right) / 2), Math.round((top + bottom) / 2)] };
  }
  return best && { ref: best.node.ref, role: best.node.role, name: best.node.name, point: best.center, distance: Math.round(best.distance), kind: "untrusted_web_page_data" };
}

function pointRefusal(observation, point, expect, result, origin) {
  if (!["point_mismatch", "not_actionable", "transparent_overlay", "disabled", "blocked_by"].includes(result.reason)) return result;
  const image = observation.imageGeometry, sx = image.width / image.cssWidth, sy = image.height / image.cssHeight;
  const hit = result.hit && { ...result.hit, kind: "untrusted_web_page_data", rect: result.hit.rect && [Math.round((result.hit.rect.x + origin.x) * sx), Math.round((result.hit.rect.y + origin.y) * sy),
    Math.round(result.hit.rect.width * sx), Math.round(result.hit.rect.height * sy)] };
  const nearest = nearestControl(observation, point);
  const canvas = /^canvas(?:\s|$)/iu.test(expect);
  const generic = `The point reached ${hit ? "the element in hit (role, name, class_words, screenshot rect [x,y,width,height])" : "no element that accepts input"}; ${result.reason === "not_actionable" ? "it does not accept input. " : ""}${nearest ? "nearest is the closest observed control and its screenshot point: use nearest.ref if it is the intended control." : "no observed control is near; observe again or choose a visible ref."} No steps were dispatched.`;
  return { ...result, ...(hit ? { hit } : {}), ...(nearest ? { nearest } : {}), rejected_point: point, image_geometry: observation.imageGeometry,
    untrusted_content: { kind: "web_page_data", capture_regions: observation.captureRegions },
    recovery: canvas && !result.hit?.ref
      ? "This screenshot point does not hit the observed canvas. NO steps in the batch were dispatched, including earlier steps. This is coordinate validation, not an input delivery failure. Keep every point inside one canvas: left<=x<right, top<=y<bottom in capture_regions.bounds (a region is [x,y,width,height], so its bottom is y+height). Then resend the whole batch."
      : result.recovery ? `${result.recovery} ${generic}` : generic };
}
