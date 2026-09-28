import { CENTER, HS_R } from "./constants";
import { sdRibbon } from "./ribbon-geometry";

/**
 * The morphing outline as a signed distance: the ribbon's SDF blended into the moon's
 * disc SDF by progress g. One blend moves every point of the outline at once (the lobes
 * pull in toward the centre while the waist rounds out), with no stagger and no twist.
 */
export function morphSd(sr: number, dc: number, g: number, br: number) {
  return sr + (dc - HS_R * br - sr) * g;
}

/** Rays sampling the morphing outline for the clip (chord error < 0.5 design units on the lobes). */
export const OUTLINE_RAYS = 64;
const OUTLINE_MAX_R = 440;
/** Bisection steps: 440 / 2^12 ~ 0.1 design units. */
const OUTLINE_BISECT = 12;

function insideOutline(dx: number, dy: number, r: number, g: number, br: number) {
  return morphSd(sdRibbon(CENTER + dx * r, CENTER + dy * r), r, g, br) <= 0;
}

/**
 * Radius of the morphing outline along each of OUTLINE_RAYS rays from the centre (the first
 * zero of morphSd). Every blend of the ribbon and the disc is star-shaped about the centre,
 * so this polygon is the whole outline. Writes into `out`; no allocation.
 */
export function traceOutline(g: number, br: number, out: Float32Array) {
  for (let a = 0; a < OUTLINE_RAYS; a += 1) {
    const angle = (a / OUTLINE_RAYS) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    // Star-shaped: each ray is inside on [0, r*) and outside beyond, so bisection finds r*.
    let lo = 0;
    let hi = OUTLINE_MAX_R;
    for (let k = 0; k < OUTLINE_BISECT; k += 1) {
      const mid = (lo + hi) / 2;
      if (insideOutline(dx, dy, mid, g, br)) lo = mid;
      else hi = mid;
    }
    out[a] = (lo + hi) / 2;
  }
}

/**
 * How far past the morphing outline the clip reaches: 0 at rest (the exact logo edge), opening
 * with progress so the edge resolves into whole dots; the clip is released once it clears them.
 */
export function clipMargin(g: number, pitch: number) {
  return g >= CLIP_RELEASE ? Number.POSITIVE_INFINITY : 3 * pitch * g;
}
/**
 * Progress past which the clip trims nothing: from ~0.45 on, every dot edge (with the riso
 * misregistration) already lies within the margin (checked in the morph tests), so releasing
 * here is pixel-identical and skips the per-frame outline trace and mask composite for the
 * rest of the morph. 0.6 keeps a >= 1.5x margin at every size class.
 */
export const CLIP_RELEASE = 0.6;
