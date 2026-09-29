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
  tall: { rx: 58, rz: 18 },
};

/** Canvas px between neighbouring sheets on the frame (the label ladder's pitch). */
export const PITCH: Record<HeroLayout, number> = { wide: 64, tall: 88 };

/** Room the labels take right of the stack, and above and below its ends (canvas px). */
const LABEL = { wide: { w: 224, h: 22 }, tall: { w: 200, h: 40 } } as const;
const MARGIN = { wide: 36, tall: 16 } as const;

const rad = (deg: number) => (deg * Math.PI) / 180;

/** How far the camera moves in on the stack while its sheets are spread (the stack crops at the frame, its labels do not). */
export const ZOOM: Record<HeroLayout, number> = { wide: 2.7, tall: 2.5 };

/** A sheet's height above the page (sheet px along its normal): the camera scales x and y, not z, so the sheets stand PITCH apart on the frame at any zoom. */
export const lift = (layout: HeroLayout, k: number) => (k * PITCH[layout]) / Math.sin(rad(TURN[layout].rx));

/**
 * The quarter-view camera on the screen box: the whole stack and its labels
 * fitted and centred. Zoomed, it comes in by ZOOM with the ladder of labels
 * kept in frame (the right corners, then the labels, stay inside; the stack
 * itself may crop at the left, top and bottom).
 */
export function quarter(canvas: { w: number; h: number }, box: Box, layout: HeroLayout, zoomed = false): Pose & { s: number } {
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
  const fit = Math.min(room.w / (maxX - minX), room.h / (maxY - minY));
  const s = zoomed ? fit * ZOOM[layout] : fit;
  // Where the stack (and its labels) is centred, relative to the screen's centre on the frame.
  const corner = turn(box.w / 2, -box.h / 2);
  const mid = zoomed
    ? {
        // The top right corner (where the labels hang) pinned so the labels end at the frame's margin,
        // and the ladder of them centred on the frame's height.
        x: s * corner.x - (canvas.w / 2 - MARGIN[layout] - label.w),
        y: s * corner.y - (rise - label.h) / 2,
      }
    : {
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

/** How far a label is brought toward the viewer (canvas px along the view axis) to stand clear of every sheet of the spread stack (twice the reach, as the label is drawn back by the camera scale). */
export const clearance = (layout: HeroLayout) => {
  const { rx } = TURN[layout];
  return (SHEETS.length * 2 * PITCH[layout]) / (Math.sin(rad(rx)) * Math.cos(rad(rx)));
};
