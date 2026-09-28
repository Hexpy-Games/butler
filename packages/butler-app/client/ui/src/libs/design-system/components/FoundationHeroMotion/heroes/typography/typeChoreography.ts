import { cut, fit, focus, type Box, type Key, type Pose, type Track } from "../../heroTimeline";

/**
 * 02 Typography hero, "from token to product": one 64-beat cycle (20.5 s at
 * --motion-deliberate 320 ms). Beat marks:
 *
 *   0–11   Typeface   "Aa가" sweeps the weight axis 400 → 45 → 920 → 620 (cut
 *                     in place, the thumb scrubs), the four weight tokens tick
 *                     in, Latin and Hangul part and meet again (one stack)
 *   11–13  Match cut  the specimen shrinks into the H2 rung and becomes its text
 *   13–22  Scale      the camera lays the page down; role rungs rise in a
 *                     staggered cascade, their line boxes draw in (leading)
 *   22–26  Numerals   the camera pushes into MetricValue; tabular digits roll
 *   26–44  Assembly   real components rise from depth; each rung's text flies
 *                     into its place (title, label, message, code, meta,
 *                     dashboard title, metric) while the camera dollies panel
 *                     to panel and the rest of each component cascades in
 *   44–61  Settle     the camera springs back to the composed poster and holds
 *   61–64  Loop       the product recedes, the specimen grows back to centre
 */
export const BEATS = 64;

export const FLIGHTS = ["title", "dash", "field", "ask", "command", "meta", "metric"] as const;
export type Flight = (typeof FLIGHTS)[number];
export const PANELS = ["settings", "chat", "metric", "composer"] as const;
export type Panel = (typeof PANELS)[number];
export const METRIC_ROLL = "1,284";

/** The Pretendard Variable axis and the four weight tokens on it. */
export const AXIS = { min: 45, max: 920 } as const;
export const WEIGHT_TOKENS: Array<[string, number]> = [["regular", 400], ["medium", 500], ["semibold", 560], ["strong", 620]];
/** Weight stops of the sweep and how long each holds (beats); the last one, the brand weight, is the poster. */
export const SWEEP = [400, 260, 150, 45, 260, 500, 620, 920, 740, 620];
const HOLD = [0.4, 0.34, 0.3, 1, 0.3, 0.28, 0.28, 1, 0.45];
export const POSTER_WEIGHT = 620;

/** Boxes of the poster layout in canvas px, as measured on the live components. */
export interface TypeGeometry {
  canvas: { w: number; h: number };
  glyph: Box;
  /** Poster scale of the glyph (it is set large and drawn small). */
  glyphScale: number;
  halves: { latin: Box; hangul: Box };
  ladder: Box;
  rungs: Record<Flight, Box>;
  fly: Record<Flight, Box>;
  land: Record<Flight, Box>;
  panels: Record<Panel, Box>;
  overlays: Record<"axis" | "cap-latin" | "cap-hangul" | "cap-stack" | "cap-tnum", Box>;
  axisWidth: number;
  digitLine: number;
  digits: number[];
  words: number;
}

/** When each flight leaves its rung (beats); it lands 2.2 beats later. */
export const FLIGHT_AT: Record<Flight, number> = { title: 29, field: 30, ask: 32.6, command: 33.6, meta: 34.6, dash: 36.6, metric: 37.4 };
export const FLIGHT_BEATS = 2.2;
export const center = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });
const sweepAt = (k: number) => 1 + HOLD.slice(0, k).reduce((sum, beat) => sum + beat, 0);

export function select(name: string): string {
  return `[data-t="${name}"]`;
}

/** Act I: the specimen, its stops, the axis and the Latin/Hangul captions. */
export function typeface(g: TypeGeometry): Track[] {
  const { canvas, glyph } = g;
  const tall = canvas.h > canvas.w;
  const big = Math.min((canvas.w * (tall ? 0.62 : 0.5)) / glyph.w, (canvas.h * 0.34) / glyph.h);
  const c = { x: canvas.w / 2, y: canvas.h * (tall ? 0.36 : 0.42) };
  const at = center(glyph);
  // The glyph is set large and drawn at 1/q in the poster (crisp when it grows), scaled from its top-left.
  const q = g.glyphScale;
  const glyphPose = (x: number, y: number, s: number): Pose => ({ x: (x - glyph.x - (s * glyph.w) / 2) / q, y: (y - glyph.y - (s * glyph.h) / 2) / q, s });
  const bigPose = glyphPose(c.x, c.y, big);
  const title = center(g.fly.title);
  const shrink = g.fly.title.h / glyph.h;
  const bottom = c.y + (glyph.h * big) / 2;
  const place = (box: Box, x: number, y: number): Pose => ({ x: x - box.x - box.w / 2, y: y - box.y });
  const part = glyph.w * (tall ? 0.11 : 0.16);
  const halfX = (half: Box, sign: number) => c.x + (center(half).x - at.x + sign * part) * big;
  const last = SWEEP.length - 1;
  const lastStop: Key[] = [{ at: 0, o: 1 }, { at: sweepAt(0) - 0.01, o: 1 }, { at: sweepAt(0), o: 0 }, { at: sweepAt(last) - 0.01, o: 0 }, { at: sweepAt(last), o: 1 }];
  const steps = (name: string) => SWEEP.map((_, k): Track => ({ select: select(`${name}-${k}`), keys: k === last ? lastStop : cut(sweepAt(k), sweepAt(k + 1), BEATS) }));
  const thumb = SWEEP.map((weight, k): Key => ({ at: sweepAt(k), x: ((weight - AXIS.min) / (AXIS.max - AXIS.min)) * g.axisWidth, ease: "decelerate" }));
  const axis = place(g.overlays.axis, c.x, bottom + 18);
  const fadeIn = (from: number, pose: Pose, rise = 8): Key[] => [{ at: 0, ...pose, y: pose.y! + rise, o: 0 }, { at: from, o: 0 }, { at: from + 0.8, y: pose.y, o: 1, ease: "decelerate" }];
  const capY = bottom + 14;
  return [
    ...steps("stop"),
    { select: select("thumb"), keys: [{ at: 0, x: thumb.at(-1)!.x }, ...thumb] },
    { select: select("axis"), keys: [...fadeIn(0.4, axis), { at: 7.4, o: 1 }, { at: 8.2, o: 0, y: axis.y! + 6, ease: "accelerate" }] },
    { select: select("ticks"), keys: [{ at: 0, o: 0, y: 6 }, { at: 5, o: 0, y: 6 }, { at: 5.9, o: 1, y: 0, ease: "decelerate" }] },
    { select: select("weights"), keys: [{ at: 0, o: 0, y: 6 }, { at: 5.6, o: 0, y: 6 }, { at: 6.6, o: 1, y: 0, ease: "decelerate" }] },
    { select: select("latin"), keys: [{ at: 0, x: 0 }, { at: 7.6, x: 0 }, { at: 8.8, x: -part / q, ease: "emphasized" }, { at: 10.2, x: -part / q }, { at: 11.2, x: 0, ease: "emphasized" }] },
    { select: select("hangul"), keys: [{ at: 0, x: 0 }, { at: 7.7, x: 0 }, { at: 8.9, x: part / q, ease: "emphasized" }, { at: 10.2, x: part / q }, { at: 11.2, x: 0, ease: "emphasized" }] },
    ...([["cap-latin", g.halves.latin, -1, 8.6], ["cap-hangul", g.halves.hangul, 1, 8.8]] as const).map(([name, half, sign, from]): Track => ({
      select: select(name), keys: [...fadeIn(from, place(g.overlays[name], halfX(half, sign), capY)), { at: 10, o: 1 }, { at: 10.6, o: 0, ease: "accelerate" }],
    })),
    { select: select("family"), keys: [{ at: 0, o: 0 }, { at: 45.6, o: 0 }, { at: 47, o: 1, ease: "decelerate" }, { at: 61, o: 1 }, { at: 61.6, o: 0, ease: "accelerate" }] },
    { select: select("cap-stack"), keys: [...fadeIn(9.2, place(g.overlays["cap-stack"], c.x, capY + g.overlays["cap-latin"].h + 8)), { at: 10.1, o: 1 }, { at: 10.7, o: 0, ease: "accelerate" }] },
    {
      select: select("glyph"),
      keys: [
        { at: 0, ...bigPose }, { at: 10.4, ...bigPose }, { at: 11.4, ...glyphPose(c.x, c.y, big * 1.05), ease: "decelerate" },
        { at: 13.2, ...glyphPose(title.x, title.y, shrink), ease: "emphasized" },
        { at: 45, x: 0, y: 0, s: 1 }, { at: 61.4, x: 0, y: 0, s: 1 }, { at: BEATS, ...bigPose, ease: "emphasized" },
      ],
    },
    // Opacity lives on the glyph's box so the flight above stays one continuous move.
    { select: select("glyph-fade"), keys: [{ at: 0, o: 1 }, { at: 12.5, o: 1 }, { at: 13.2, o: 0, ease: "accelerate" }, { at: 45.6, o: 0 }, { at: 46.8, o: 1, ease: "decelerate" }] },
  ];
}

/** Camera poses, shared by the acts. */
export function cameras(g: TypeGeometry) {
  const { canvas } = g;
  const ladder = g.ladder;
  const top: Box = { ...ladder, h: ladder.h / 2 };
  const low: Box = { ...ladder, y: ladder.y + ladder.h / 2, h: ladder.h / 2 };
  const onLadder = fit(canvas, ladder, 0.8, 1.7);
  const panel = (p: Panel, turn: Pose) => focus(canvas, g.panels[p], fit(canvas, g.panels[p], 0.78, 1.6), turn);
  return {
    rest: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1 } as Pose,
    ladderTop: focus(canvas, top, onLadder * 1.1, { rx: 30, rz: -5 }),
    ladderLow: focus(canvas, low, onLadder * 1.1, { rx: 18, rz: -2 }),
    metric: focus(canvas, g.fly.metric, fit(canvas, g.fly.metric, 0.5, canvas.h > canvas.w ? 1.4 : 2.4), { ry: -10 }),
    wide: focus(canvas, { x: 0, y: 0, ...canvas }, 0.9, { rx: 8, ry: -12 }),
    settings: panel("settings", { ry: -7 }),
    chat: panel("chat", { ry: 6 }),
    metricPanel: panel("metric", { ry: -6 }),
    composer: panel("composer", { rx: 6 }),
  };
}
