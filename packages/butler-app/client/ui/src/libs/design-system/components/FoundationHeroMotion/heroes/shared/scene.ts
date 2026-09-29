import { fit, focus, type Box, type Pose } from "../../heroTimeline";
import { GRID, type HeroLayout } from "./grid";

/** Badge gutter beside a component while it builds (badge column plus a grid gutter), in canvas px. */
export const BADGE_GUTTER: Record<HeroLayout, number> = { wide: 300, tall: 0 };

/** Width of one badge character (canvas px at poster scale), to size the gutter before badges are drawn. */
export const BADGE_CHAR = 6.6;

/** Vertical pitch between stacked badges (canvas px). */
export const BADGE_PITCH = 28;

/** How far out a badge stands from the component's edge: three grid gutters (below the component on the tall canvas). */
export const badgeReach = (layout: HeroLayout) => GRID[layout].gutter * (layout === "tall" ? 1.5 : 3);

/** Distance between neighbouring scene cells, in canvas sizes. */
export const CELL = 1.25;

export const REST: Pose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1 };

/**
 * The camera's path: every scene of a chapter (its prelude scenes, then one
 * per build) sits in its own canvas-sized cell, and consecutive cells are one
 * step apart, either right or down, alternating, so every camera move runs
 * along one axis and never turns back. The path ends on the last build's
 * frame inside the poster (that component is built in place), so the finale
 * only zooms out.
 */
export function scenePath(count: number, end: { x: number; y: number }, canvas: { w: number; h: number }, into: "right" | "down" = "right"): Array<{ x: number; y: number }> {
  const cells = [{ x: 0, y: 0 }];
  for (let k = 1; k < count; k += 1) {
    const last = cells[0]!;
    // Walking back from the end: a step `into` the last scene, the other axis before it, and so on.
    const right = (k % 2 === 1) === (into === "right");
    cells.unshift(right ? { x: last.x - 1, y: last.y } : { x: last.x, y: last.y - 1 });
  }
  return cells.map((cell) => ({ x: end.x + cell.x * CELL * canvas.w, y: end.y + cell.y * CELL * canvas.h }));
}

/** Where the token field waits while the components build: well off the path (up and right of the poster). */
export function fieldAway(canvas: { w: number; h: number }): { x: number; y: number } {
  return { x: 2.5 * CELL * canvas.w, y: -2.5 * CELL * canvas.h };
}

/** The camera on a scene cell: centred on the cell (so moves between cells stay on one axis), zoomed to fit `content`. */
export function viewCell(canvas: { w: number; h: number }, center: { x: number; y: number }, content: Box, fill = 0.86, cap = 2): Pose {
  const zoom = fit(canvas, content, fill, cap);
  return focus(canvas, { x: center.x - 1, y: center.y - 1, w: 2, h: 2 }, zoom);
}

/**
 * On the tall canvas the components are built where they stand in the
 * poster's column, one under the other: the camera steps down the column,
 * each frame as wide as the canvas allows and resting on the bottom of the
 * component being built (and its badges), so the ones built before fill the
 * frame above it. No component moves.
 */
export function columnViews(canvas: { w: number; h: number }, frames: Box[]) {
  // One zoom and one centre line for the whole column (the canvas's middle), so every step is straight down.
  const left = Math.min(...frames.map((box) => box.x));
  const right = Math.max(...frames.map((box) => box.x + box.w));
  const half = Math.max(canvas.w / 2 - left, right - canvas.w / 2);
  const zoom = fit(canvas, { x: 0, y: 0, w: half * 2, h: 1 }, 0.96, 2.4);
  const view = canvas.h / zoom;
  const centers = frames.map((box) => {
    const bottom = box.y + box.h + 16 / zoom;
    return { x: canvas.w / 2, y: box.h + 32 / zoom > view ? box.y + box.h / 2 : bottom - view / 2 };
  });
  const stage = centers.map((c) => focus(canvas, { x: c.x - 1, y: c.y - 1, w: 2, h: 2 }, zoom));
  return { shift: frames.map(() => ({ x: 0, y: 0 })), stage, centers };
}

/**
 * The finale's pose: the poster at rest on the wide canvas; on the tall
 * canvas the whole poster (token field and every component) fitted into the
 * portrait frame, so nothing is cropped.
 */
export function finalePose(layout: HeroLayout, canvas: { w: number; h: number }, boxes: Box[]): Pose {
  if (layout === "wide") return REST;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const all = { x, y, w: Math.max(...boxes.map((box) => box.x + box.w)) - x, h: Math.max(...boxes.map((box) => box.y + box.h)) - y };
  return focus(canvas, all, fit(canvas, all, 0.94, 1.4));
}

/** Camera poses of the builds: each frame (component and badge gutter) centred on its cell, as large as the frame allows. */
export function buildViews(layout: HeroLayout, canvas: { w: number; h: number }, frames: Box[], centers: Array<{ x: number; y: number }>) {
  const tall = layout === "tall";
  const shift = frames.map((box, k) => ({ x: centers[k]!.x - (box.x + box.w / 2), y: centers[k]!.y - (box.y + box.h / 2) }));
  const stage = frames.map((box, k) => viewCell(canvas, centers[k]!, box, tall ? 0.94 : 0.8, tall ? 2.4 : 2));
  return { shift, stage };
}

/** What a poster paints and the stage's visible part of the canvas, in canvas px (fitInk.ts): the finale frames them. */
export interface Framing {
  ink?: Box;
  view?: Box;
}

/** The most a finale draws the poster larger than laid out (product fidelity), and the least. */
const REST_ZOOM = { min: 0.4, max: 1.35 } as const;

/**
 * The finale's camera: the poster's painted box centred in the visible
 * frame, as large as fits inside one grid margin on every side, so the
 * insets are equal all round. `reserve` keeps canvas px along the bottom
 * clear (a chapter's fixed footer). With no measurement it is the poster at rest.
 */
export function inkPose(layout: HeroLayout, canvas: { w: number; h: number }, ink: Box | undefined, view?: Box, reserve = 0): Pose {
  if (!ink) return REST;
  const margin = GRID[layout].margin;
  const seen = view ?? { x: 0, y: 0, w: canvas.w, h: canvas.h };
  const room = { w: seen.w - 2 * margin, h: seen.h - 2 * margin - reserve };
  const zoom = Math.min(REST_ZOOM.max, Math.max(REST_ZOOM.min, Math.min(room.w / ink.w, room.h / ink.h)));
  const pose = focus(canvas, ink, zoom);
  // The frame's own centre (the canvas's centre unless the stage crops one side more), less half the reserve.
  const centre = { x: seen.x + seen.w / 2 - canvas.w / 2, y: seen.y + seen.h / 2 - canvas.h / 2 - reserve / 2 };
  return { ...pose, x: (pose.x ?? 0) + centre.x, y: (pose.y ?? 0) + centre.y };
}
