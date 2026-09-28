import { fit, focus, type Box, type Pose } from "../../heroTimeline";
import type { Panel, TypeGeometry } from "./typeChoreography";
import { col } from "./typeGrid";

/** Camera poses: one subject at a time, framed on the grid. */
export function cameras(g: TypeGeometry) {
  const { canvas } = g;
  const tall = g.layout === "tall";
  const frame = (box: Box, turn: Pose) => focus(canvas, box, fit(canvas, box, 0.84, tall ? 1.5 : 2), turn);
  const panel = (p: Panel, turn: Pose) => frame(g.panels[p], turn);
  // The conversation card stretches to its column; frame the turn itself.
  const turn = [g.land.ask, g.land.command, g.land.meta];
  const top = Math.max(g.panels.chat.y, Math.min(...turn.map((b) => b.y)) - 24);
  const chat: Box = { x: g.panels.chat.x, y: top, w: g.panels.chat.w, h: Math.max(...turn.map((b) => b.y + b.h)) + 24 - top };
  const product: Box = tall ? g.panels.chat : { x: col("wide", 6).x, y: 40, w: col("wide", 6, 7).w, h: canvas.h - 80 };
  return {
    rest: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1 } as Pose,
    ladder: focus(canvas, g.ladder, fit(canvas, g.ladder, 0.9, 1.6), { rx: 16, rz: -3 }),
    ladderDolly: focus(canvas, g.ladder, fit(canvas, g.ladder, 0.9, 1.6) * 1.05, { rx: 8, rz: -1 }),
    metric: focus(canvas, g.fly.metric, fit(canvas, g.fly.metric, 0.5, tall ? 1.4 : 2.2), { ry: -8 }),
    wide: focus(canvas, product, fit(canvas, product, 0.94, 1.2), { rx: 6, ry: -10 }),
    settings: panel("settings", { ry: -5 }),
    chat: frame(chat, { ry: 5 }),
    metricPanel: panel("metric", { ry: -5 }),
    composer: panel("composer", { rx: 5 }),
  };
}
