import { fit, focus, type Box, type Pose } from "../../heroTimeline";
import { PANELS, type Flight, type Panel, type TypeGeometry } from "./typeChoreography";
import { CELL } from "../shared/scene";
import { BADGE_GUTTER } from "./typeLines";

/** The part of a panel the camera frames while building it (the conversation card stretches, so its lines). */
function frameBox(g: TypeGeometry, panel: Panel): Box {
  const own = g.lines.filter((line) => line.panel === panel);
  // The badge gutter left of the component is part of the frame.
  const gutter = BADGE_GUTTER[g.layout];
  const grow = (box: Box): Box => ({ ...box, x: box.x - gutter, w: box.w + gutter });
  const box = g.panels[panel];
  if (panel !== "chat") return grow(box);
  const lines = own.map((line) => ({ y: box.y + line.box.y, h: line.box.h }));
  const top = Math.max(box.y, Math.min(...lines.map((line) => line.y)) - 32);
  return grow({ x: box.x, y: top, w: box.w, h: Math.max(...lines.map((line) => line.y + line.h)) + 32 - top });
}

const center = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

/** The list close-up's framing of one row (the list's type filling the frame). */
function rowBox(g: TypeGeometry, flight: Flight): Box {
  return { x: g.ladder.x, y: g.rungs[flight].y, w: g.ladder.w, h: g.rungs[flight].h };
}

/**
 * The camera's path, one axis per move and never turning back (see
 * ../shared/scene.ts): the opening and the list play in a cell up and left of
 * the poster (`start`, the offset their elements take), then down to the
 * first build, right, down, and right onto the composer, which is built in
 * its place in the poster so the finale only zooms out.
 */
export function startOffset(g: TypeGeometry): { x: number; y: number } {
  const end = center(frameBox(g, "composer"));
  const row = center(rowBox(g, "metric"));
  return { x: end.x - 2 * CELL * g.canvas.w - row.x, y: end.y - 2 * CELL * g.canvas.h - row.y };
}

/**
 * Build stages and camera poses. Each component is offset (`shift`) from its
 * poster place to its cell on the path, framed there one at a time as large
 * as the frame allows, and later flies back into the poster for the finale.
 */
export function cameras(g: TypeGeometry) {
  const { canvas } = g;
  const tall = g.layout === "tall";
  const cap = tall ? 1.6 : 2;
  const end = center(frameBox(g, "composer"));
  const [px, py] = [CELL * canvas.w, CELL * canvas.h];
  const centers = [{ x: end.x - 2 * px, y: end.y - py }, { x: end.x - px, y: end.y - py }, { x: end.x - px, y: end.y }];
  const start = startOffset(g);
  const moved = (box: Box): Box => ({ ...box, x: box.x + start.x, y: box.y + start.y });
  // The last component (the composer) is built in its own place in the poster, so the finale can
  // zoom out from it while the others gather around it.
  const shift = Object.fromEntries(PANELS.map((panel, k) => {
    if (k === PANELS.length - 1) return [panel, { x: 0, y: 0 }];
    const box = frameBox(g, panel);
    return [panel, { x: centers[k]!.x - (box.x + box.w / 2), y: centers[k]!.y - (box.y + box.h / 2) }];
  })) as Record<Panel, { x: number; y: number }>;
  const stage = PANELS.map((panel) => {
    const box = frameBox(g, panel);
    const moved = { ...box, x: box.x + shift[panel].x, y: box.y + shift[panel].y };
    return focus(canvas, moved, fit(canvas, moved, tall ? 1 : 0.8, cap));
  });
  // Close enough that the list's type fills the frame; cropping at the edges is fine.
  const close = Math.min(2.4, (canvas.w * 1.1) / g.ladder.w);
  return {
    shift,
    stage,
    start,
    /** The poster, at rest. */
    rest: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1 } as Pose,
    /** The opening, flat, in its cell. */
    open: focus(canvas, moved({ x: 0, y: 0, w: canvas.w, h: canvas.h }), 1),
    /** Close on one row of the list, flat, the list's type filling the frame. */
    row: (flight: Flight) => focus(canvas, moved(rowBox(g, flight)), close),
  };
}
