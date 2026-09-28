import { fit, focus, type Box, type Pose } from "../../heroTimeline";
import { PANELS, type Panel, type TypeGeometry } from "./typeChoreography";
import { BADGE_GUTTER } from "./typeLines";

/** Where each component is built: an empty area off the poster, reached by moving down or sideways. */
function stageCenters(g: TypeGeometry): Array<{ x: number; y: number }> {
  const { w, h } = g.canvas;
  if (g.layout === "tall") return PANELS.map((_, k) => ({ x: w / 2, y: h * (1.7 + k * 1.1) }));
  return [{ x: w * 0.28, y: h * 1.62 }, { x: w * 1.2, y: h * 1.62 }, { x: w * 1.2, y: h * 2.62 }, { x: w * 0.28, y: h * 2.62 }];
}

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

/**
 * Build stages and camera poses. Each component is offset (`shift`) from its
 * poster place to an empty stage, framed there one at a time as large as the
 * frame allows, and later flies back into the poster for the finale.
 */
export function cameras(g: TypeGeometry) {
  const { canvas } = g;
  const tall = g.layout === "tall";
  const cap = tall ? 1.6 : 2;
  const centers = stageCenters(g);
  const shift = Object.fromEntries(PANELS.map((panel, k) => {
    const box = frameBox(g, panel);
    return [panel, { x: centers[k]!.x - (box.x + box.w / 2), y: centers[k]!.y - (box.y + box.h / 2) }];
  })) as Record<Panel, { x: number; y: number }>;
  const stage = PANELS.map((panel) => {
    const box = frameBox(g, panel);
    const moved = { ...box, x: box.x + shift[panel].x, y: box.y + shift[panel].y };
    return focus(canvas, moved, fit(canvas, moved, tall ? 0.96 : 0.8, cap));
  });
  const rung = g.rungs.title;
  // Close enough that the list's type fills the frame; cropping at the edges is fine.
  const close = Math.min(2.4, (canvas.w * 1.1) / g.ladder.w);
  return {
    shift,
    stage,
    rest: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1 } as Pose,
    ladder: focus(canvas, g.ladder, fit(canvas, g.ladder, 0.98, 2.2)),
    top: focus(canvas, { x: g.ladder.x, y: rung.y, w: g.ladder.w, h: rung.h }, close),
    bottom: focus(canvas, { x: g.ladder.x, y: g.rungs.metric.y, w: g.ladder.w, h: g.rungs.metric.h }, close),
  };
}
