import type { Box, Key, Pose, Track } from "../../heroTimeline";
import { specimenLayout, type SpecimenMetrics } from "./specimenMetrics";
import type { LineInfo } from "./typeLines";
import { col, onBaseline, SPECIMEN, type TypeLayout } from "./typeGrid";
import { OUTLINE_EM } from "./TypeSpecimen";

/**
 * 02 Typography hero, "from token to product": one 98.4-beat cycle (31.5 s at
 * --motion-deliberate 320 ms). Beat marks:
 *
 *   0–7    Construction  metric guides draw in; the real Pretendard outlines of
 *                        "A가" draw along their contours; values attach
 *   5–9    Fill          the glyphs fill, outlines and guides clear
 *   9–18   Weight        300 → 800 → 620 with the control, guides and readout
 *   18–20  Match cut     the specimen shrinks onto the H2 rung: "Appearance"
 *   20–31  Type list     the role list rises, flat and frame-filling; the camera
 *                        closes in and travels down it into the empty space below
 *   31–81  Build         four real components, one at a time, each in its own
 *                        empty area: surface, structure, then its text lines
 *                        drawn like the specimen (guide, outline, fill) with
 *                        the typography token of each line on a badge
 *   81–86  Finale        everything pushes up and gathers onto the grid
 *   86–94  Settle        the composed poster: tokens beside the product
 *   94–98  Loop          the product recedes, the specimen grows back and its
 *                        fill clears to the blueprint of beat 0
 *
 * Every placement comes from the grid (typeGrid.ts) or from measuring the
 * poster, so it holds for both canvases, themes, languages and fonts. The
 * components gather into the poster from FINALE; the loop starts at LOOP.
 */
export const FINALE = 81.4;
export const LOOP = 94.4;
export const BEATS = 98.4;

export const FLIGHTS = ["title", "dash", "field", "ask", "command", "meta", "metric"] as const;
export type Flight = (typeof FLIGHTS)[number];
export const PANELS = ["settings", "chat", "metric", "composer"] as const;
export type Panel = (typeof PANELS)[number];
export const METRIC_ROLL = "1,284";
export const AXIS = { min: 45, max: 920 } as const;

/** Boxes of the poster layout in canvas px, as measured on the live components. */
export interface TypeGeometry {
  layout: TypeLayout;
  canvas: { w: number; h: number };
  specimen: Box;
  /** Poster scale of the specimen (laid out at Act I size, drawn small). */ specimenScale: number;
  ladder: Box;
  rungs: Record<Flight, Box>;
  fly: Record<Flight, Box>;
  /** Text lines each component builds, measured in their panels. */
  lines: LineInfo[];
  panels: Record<Panel, Box>;
  control: Box;
  tnum: Box;
  controlTrack: number;
  readoutLine: number;
  digitLine: number;
  digits: number[];
}

export function select(name: string): string {
  return `[data-t="${name}"]`;
}

/** Weight of the filled specimen at its marks: drawn light, pushed heavy, settled on --font-weight-strong. */
const WEIGHT: Array<[number, 300 | 800 | 620]> = [[9.8, 300], [12.8, 800], [13.6, 800], [15.8, 620]];
const EASE_AT = { 12.8: "standard", 15.8: "decelerate" } as const;
/** Guides and values leave for the fill, return for the weight, leave for the match cut. */
const [CLEAR, BACK, AWAY] = [[6.4, 7.2], [8.8, 9.6], [17.2, 18]] as const;

function show(from: number, to: number, end: readonly [number, number] = CLEAR, extra: Pose = {}): Key[] {
  return [{ at: 0, o: 0, ...extra }, { at: from, o: 0 }, { at: to, o: 1, ease: "decelerate" }, { at: end[0], o: 1 }, { at: end[1], o: 0, ease: "accelerate" }];
}

/** Keys over the weight marks for any quantity that follows the weight. */
function byWeight(value: (weight: 300 | 800 | 620) => Pose): Key[] {
  return [{ at: 0, ...value(300) }, ...WEIGHT.map(([at, weight]): Key => ({ at, ...value(weight), ease: EASE_AT[at as keyof typeof EASE_AT] ?? "standard" }))];
}

/** Act I: the specimen in construction, filled, and moved along the weight axis. */
export function specimenTracks(g: TypeGeometry, m: SpecimenMetrics): Track[] {
  const { layout, canvas, specimen } = g;
  const size = SPECIMEN[layout].size;
  const q = g.specimenScale;
  const at = (weight: 300 | 800 | 620) => specimenLayout(m, size, weight);
  const rest = at(620);
  const tall = layout === "tall";
  const group = 24 + rest.height + 28 + (tall ? 24 + g.control.h : 0);
  const top = onBaseline((canvas.h - group) / 2 + 24, layout);
  const left = col(layout, 1).x;
  const place = (x: number, y: number, visual: number): Pose => ({ x: (x - specimen.x) / q, y: (y - specimen.y) / q, s: visual / q });
  const big = place(left, top, 1);
  const title = place(g.fly.title.x, g.fly.title.y, g.fly.title.h / rest.height);
  const control = tall ? { x: left, y: onBaseline(top + rest.height + 52, layout) } : { x: col(layout, 9).x, y: onBaseline(top + rest.height / 2 - g.control.h / 2, layout) };
  const shiftG = (weight: 300 | 800 | 620) => at(weight).originG - rest.originG;
  const band = (width: (w: 300 | 800 | 620) => number, x: (w: 300 | 800 | 620) => number) =>
    byWeight((w) => ({ x: x(w), sx: Math.max(0.05, Math.abs(width(w))) / Math.max(1, Math.abs(width(620))) }));
  const guides = (from: number, to: number): Key[] => [...show(from, to), { at: BACK[0], o: 0 }, { at: BACK[1], o: 1, ease: "decelerate" }, { at: AWAY[0], o: 1 }, { at: AWAY[1], o: 0, ease: "accelerate" }];
  const cuts = (name: string): Track[] => [0, 1, 2].map((k) => ({
    select: select(`${name}-${k}`),
    keys: k === 0 ? [{ at: 0, o: 1 }, { at: 11.29, o: 1 }, { at: 11.3, o: 0 }] : k === 1 ? [{ at: 0, o: 0 }, { at: 11.29, o: 0 }, { at: 11.3, o: 1 }, { at: 14.69, o: 1 }, { at: 14.7, o: 0 }] : [{ at: 0, o: 0 }, { at: 14.69, o: 0 }, { at: 14.7, o: 1 }],
  }));
  const hline = (name: string, k: number, back: boolean): Track[] => [
    { select: select(`h-${name}`), keys: back ? guides(0.3 + k * 0.25, 1.7 + k * 0.25) : show(0.3 + k * 0.25, 1.7 + k * 0.25) },
    { select: select(`h-${name}-rule`), keys: [{ at: 0, sx: 0 }, { at: 0.3 + k * 0.25, sx: 0 }, { at: 1.7 + k * 0.25, sx: 1, ease: "decelerate" }] },
    { select: select(`h-${name}-label`), keys: [{ at: 0, o: 0 }, { at: 2.4 + k * 0.3, o: 0 }, { at: 3.2 + k * 0.3, o: 1, ease: "decelerate" }] },
  ];
  const outline = (name: string, dash: number, from: number, x: number): Track => ({
    select: select(name),
    keys: [{ at: 0, dash, o: 1, x }, { at: from, dash }, { at: from + 3.8, dash: 0 }, { at: 5.6, o: 1 }, { at: 6.6, o: 0, ease: "accelerate" }, { at: LOOP + 3.9, dash, o: 0 }, { at: BEATS, o: 1 }],
  });
  const fillKeys = (x: (w: 300 | 800 | 620) => number): Key[] => [
    { at: 0, o: 0, wght: 300, x: x(300) }, { at: 5, o: 0 }, { at: 6.4, o: 1, ease: "decelerate" },
    ...byWeight((w) => ({ wght: w, x: x(w) })), { at: LOOP + 3, o: 1 }, { at: LOOP + 3.9, o: 0, ease: "accelerate" }, { at: LOOP + 3.95, wght: 300, x: x(300) },
  ];
  return [
    ...hline("base", 0, true), ...hline("cap", 1, true), ...hline("xh", 2, false), ...hline("asc", 3, false), ...hline("desc", 4, false),
    ...["v-a0", "v-ag", "v-g1"].map((name, k): Track => ({ select: select(`${name}-rule`), keys: [{ at: 0, sy: 0 }, { at: 1.6 + k * 0.25, sy: 0 }, { at: 2.8 + k * 0.25, sy: 1, ease: "decelerate" }] })),
    ...["v-a0", "v-ag", "v-g1"].map((name, k): Track => ({
      select: select(name),
      keys: [...guides(1.6 + k * 0.25, 2.4 + k * 0.25), ...byWeight((w) => ({ x: name === "v-ag" ? shiftG(w) : name === "v-g1" ? at(w).width - rest.width : 0 }))],
    })),
    { select: select("sb-a-l"), keys: [...guides(2.4, 3.2), ...band((w) => at(w).a.lsb * size, () => 0)] },
    { select: select("sb-a-r"), keys: [...guides(2.6, 3.4), ...band((w) => (at(w).a.advance - at(w).a.inkRight) * size, (w) => (at(w).a.inkRight - rest.a.inkRight) * size)] },
    { select: select("sb-g-l"), keys: [...guides(2.8, 3.6), ...band((w) => at(w).g.lsb * size, shiftG)] },
    { select: select("sb-g-r"), keys: [...guides(3, 3.8), ...band((w) => (at(w).g.advance - at(w).g.inkRight) * size, (w) => shiftG(w) + (at(w).g.inkRight - rest.g.inkRight) * size)] },
    { select: select("gap"), keys: guides(3.6, 4.4) },
    ...["adv-a", "adv-g"].map((name, k): Track => ({
      select: select(name),
      keys: [...guides(3.2 + k * 0.3, 4 + k * 0.3), ...byWeight((w) => ({ x: k === 0 ? shiftG(w) / 2 : shiftG(w) + (at(w).width - rest.width - shiftG(w)) / 2 }))],
    })),
    ...cuts("adv-a"), ...cuts("adv-g"), ...cuts("gap"),
    { select: select("size-label"), keys: show(2.2, 3) },
    outline("outline-a", OUTLINE_EM.a * size, 0.5, 0),
    outline("outline-g", OUTLINE_EM.g * size, 1, shiftG(300)),
    { select: select("fill-a"), keys: fillKeys(() => 0) },
    { select: select("fill-g"), keys: fillKeys(shiftG) },
    {
      select: select("control"),
      keys: [{ at: 0, ...control, x: control.x + 16, o: 0 }, { at: BACK[0], o: 0 }, { at: BACK[1], x: control.x, o: 1, ease: "decelerate" }, { at: AWAY[0], o: 1 }, { at: AWAY[1], o: 0, ease: "accelerate" }],
    },
    { select: select("thumb"), keys: byWeight((w) => ({ x: ((w - AXIS.min) / (AXIS.max - AXIS.min)) * g.controlTrack })) },
    { select: select("read-100"), keys: byWeight((w) => ({ y: (6 - Math.round(w / 100)) * g.readoutLine })) },
    { select: select("read-10"), keys: byWeight((w) => ({ y: (62 - w / 10) * g.readoutLine })) },
    { select: select("token"), keys: [{ at: 0, o: 0 }, { at: 15.8, o: 0 }, { at: 16.4, o: 1, ease: "decelerate" }] },
    { select: select("family"), keys: [{ at: 0, o: 0 }, { at: FINALE + 2.6, o: 0 }, { at: FINALE + 4, o: 1, ease: "decelerate" }, { at: LOOP - 0.4, o: 1 }, { at: LOOP + 0.2, o: 0, ease: "accelerate" }] },
    {
      select: select("specimen"),
      keys: [
        { at: 0, ...big }, { at: 18.2, ...big }, { at: 19.9, ...title, ease: "emphasized" },
        { at: FINALE, x: 0, y: 0, s: 1 }, { at: LOOP, x: 0, y: 0, s: 1 }, { at: LOOP + 2.5, ...big, ease: "emphasized" },
      ],
    },
    // Opacity on the specimen's slot, so the flight above stays one continuous move.
    { select: select("slot"), keys: [{ at: 0, o: 1 }, { at: 19.4, o: 1 }, { at: 20, o: 0, ease: "accelerate" }, { at: FINALE + 2, o: 0 }, { at: FINALE + 3.4, o: 1, ease: "decelerate" }] },
  ];
}
