import type { Box, Pose } from "../../heroTimeline";
import type { HeroLayout } from "../shared/grid";
import { SHEETS } from "./layersCopy";

/**
 * The exploded stack's quarter view. The camera turns the screen (rz) and
 * tilts it back (rx); each sheet stands `gap` above the one below, so on the
 * frame the sheets step up by PITCH and their right corners form a straight
 * ladder the labels hang on. Orthographic (no perspective): every label
 * reads the same size.
 */
export const TURN: Record<HeroLayout, { rx: number; rz: number }> = {
  wide: { rx: 58, rz: 14 },
  tall: { rx: 58, rz: 0 },
};

/** Canvas px between neighbouring sheets on the frame (the label ladder's pitch). */
export const PITCH: Record<HeroLayout, number> = { wide: 40, tall: 66 };

/** Room the labels take right of the stack, and above and below its ends (canvas px). */
const LABEL = { wide: { w: 224, h: 22 }, tall: { w: 170, h: 40 } } as const;
const MARGIN = { wide: 36, tall: 16 } as const;

const rad = (deg: number) => (deg * Math.PI) / 180;

/** A sheet's height above the page (sheet px along its normal). */
export const lift = (layout: HeroLayout, k: number) => (k * PITCH[layout]) / Math.sin(rad(TURN[layout].rx));

/** The quarter-view camera on the screen box: the whole stack and its labels fitted and centred. */
export function quarter(canvas: { w: number; h: number }, box: Box, layout: HeroLayout): Pose & { s: number } {
  const { rx, rz } = TURN[layout];
  const [cz, sz, cx] = [Math.cos(rad(rz)), Math.sin(rad(rz)), Math.cos(rad(rx))];
  // The turn and tilt of a point in the screen's plane (before the camera's scale).
  const turn = (x: number, y: number) => ({
    x: x * cz - y * sz,
    y: (x * sz + y * cz) * cx,
  });
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([u, v]) => turn((u! * box.w) / 2, (v! * box.h) / 2));
  const [minX, maxX] = [Math.min(...corners.map((p) => p.x)), Math.max(...corners.map((p) => p.x))];
  const [minY, maxY] = [Math.min(...corners.map((p) => p.y)), Math.max(...corners.map((p) => p.y))];
  const rise = (SHEETS.length - 1) * PITCH[layout];
  const label = LABEL[layout];
  const room = {
    w: canvas.w - MARGIN[layout] * 2 - label.w,
    h: canvas.h - MARGIN[layout] * 2 - rise - label.h * 2,
  };
  const s = Math.min(room.w / (maxX - minX), room.h / (maxY - minY));
  // Where the stack (and its labels) is centred, relative to the screen's centre on the frame.
  const mid = {
    x: (s * (minX + maxX) + label.w) / 2,
    y: (s * (minY + maxY) - rise) / 2,
  };
  const centre = turn(box.x + box.w / 2 - canvas.w / 2, box.y + box.h / 2 - canvas.h / 2);
  return {
    x: -(s * centre.x + mid.x),
    y: -(s * centre.y + mid.y),
    z: 0,
    rx,
    ry: 0,
    rz,
    s,
  };
}
