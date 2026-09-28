import { fit, focus, type Box, type Pose } from "../../heroTimeline";
import { GRID, type HeroLayout } from "./grid";

/** Badge gutter beside a component while it builds (badge column plus a grid gutter), in canvas px. */
export const BADGE_GUTTER: Record<HeroLayout, number> = { wide: 300, tall: 170 };

/** Width of one badge character (canvas px at poster scale), to size the gutter before badges are drawn. */
export const BADGE_CHAR = 6.6;

/** How far out a badge stands from the component's edge: three grid gutters (two on the narrow tall canvas). */
export const badgeReach = (layout: HeroLayout) => GRID[layout].gutter * (layout === "tall" ? 2 : 3);

/**
 * Empty areas around the poster where components are built, one grid cell
 * (canvas-sized) each, walking round the poster so that the last stage is
 * next to the poster: the last component is built in place. The chapter's
 * prelude sits above the poster and the token field waits on the side the
 * walk does not use, so the field's side mirrors the walk.
 */
const CELLS: Array<[number, number]> = [[-1, 1], [0, 1], [1, 1], [1, 0]];

/**
 * Spacing of the stage cells (in canvas sizes) and where the token field
 * waits (in canvas widths off its own side) while the components build. The
 * tall canvas frames its builds wider than itself (the badge gutter), so it
 * spaces more.
 */
export const CELL: Record<HeroLayout, number> = { wide: 1.25, tall: 2.2 };
export const FIELD_AWAY: Record<HeroLayout, number> = { wide: 1.3, tall: 2.4 };

export function stageCenters(layout: HeroLayout, canvas: { w: number; h: number }, count: number, mirror = false): Array<{ x: number; y: number }> {
  const step = CELL[layout];
  return CELLS.slice(Math.max(0, CELLS.length - count)).map(([cx, cy]) => ({ x: canvas.w * (0.5 + step * (mirror ? -cx : cx)), y: canvas.h * (0.5 + step * cy) }));
}

export const REST: Pose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1 };

/**
 * Where each build stands and how the camera frames it: every component but
 * the last is offset (`shift`) to an empty stage, framed with its badge
 * gutter as large as the frame allows, and flies back for the finale.
 */
export function buildStages(layout: HeroLayout, canvas: { w: number; h: number }, frames: Box[], mirror = false) {
  const tall = layout === "tall";
  const centers = stageCenters(layout, canvas, frames.length - 1, mirror);
  const shift = frames.map((box, k) => (k === frames.length - 1 ? { x: 0, y: 0 } : { x: centers[k]!.x - (box.x + box.w / 2), y: centers[k]!.y - (box.y + box.h / 2) }));
  const stage = frames.map((box, k) => {
    const moved = { ...box, x: box.x + shift[k]!.x, y: box.y + shift[k]!.y };
    return focus(canvas, moved, fit(canvas, moved, tall ? 0.94 : 0.8, tall ? 1.6 : 2));
  });
  return { shift, stage };
}
