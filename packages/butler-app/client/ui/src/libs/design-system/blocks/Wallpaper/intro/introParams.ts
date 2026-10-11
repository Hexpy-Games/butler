// One frame of the first-run ink intro: the rev 5 timeline turned into the scene uniforms (the prototype params()
// verbatim). Pure: the engine passes the clock, the canvas geometry and the live looks (print beat, pointer stir).
import type { WallpaperUniformValue } from "../glsl";
import { RISO_INTRO_TIMELINE_S as T } from "./introTimeline";

/** A cubic-bezier easing (Newton steps), for the DS curves the GL clock follows. */
function bezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t, sy = (t: number) => ((ay * t + by) * t + cy) * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(d) < 1e-6) break;
      t -= (sx(t) - x) / d;
    }
    return sy(Math.min(1, Math.max(0, t)));
  };
}

/** --motion-ease-standard, --motion-ease-draw (the pen), --motion-ease-out-cubic (bloom and flow clock). */
const standard = bezier(0.2, 0, 0, 1);
const draw = bezier(0.65, 0, 0.35, 1);
const outCubic = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
/** --motion-ease-settle: a critically damped spring, x(t) = 1 - (1 + wt) e^(-wt), wT 8.6, no overshoot. */
const settle = (x: number) => {
  const a = 8.6 * Math.min(1, Math.max(0, x));
  return x >= 1 ? 1 : 1 - (1 + a) * Math.exp(-a);
};
const seg = (t: number, [a, b]: readonly [number, number]) => Math.min(1, Math.max(0, (t - a) / (b - a)));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

type Rect = readonly [number, number, number, number];

/** The canvas (CSS px), the card keep-out and the mark slot centre, both in the canvas. */
export interface IntroGeometry {
  width: number;
  height: number;
  card: Rect;
  slot: { x: number; y: number };
}

/** What moves besides the clock: the print beat (0..1 pulse), the pointer stir (x, y, push x, push y) and the edition. */
export interface IntroLooks {
  beat: number;
  stir: Rect;
  night: boolean;
}

/** The mark lands in a 64 px slot. */
const SLOT_SIZE = 64;

const f = (name: string, value: number): WallpaperUniformValue => ({ name, type: "float", value });
const v3 = (name: string, value: [number, number, number]): WallpaperUniformValue => ({ name, type: "vec3", value });

/** The scene uniforms of both passes at reveal time `t` (seconds; the end holds the dried print). */
export function introUniforms(t: number, g: IntroGeometry, looks: IntroLooks): WallpaperUniformValue[] {
  const { width: W, height: H } = g;
  const ox = W / 2, oy = H * 0.46;
  // The pen writes at hero size (140-240 px), then the mark glides to its slot.
  const size = Math.min(240, Math.max(140, Math.min(W, H) * 0.4));
  const glide = standard(seg(t, T.glide));
  const pen = draw(seg(t, T.draw)), dry = draw(seg(t, T.dry));
  const bow = settle(seg(t, T.bow));
  return [
    f("uMarkA", 1 - seg(t, T.markOut)), f("uDraw", pen), f("uDry", dry),
    v3("uMark", [lerp(ox, g.slot.x, glide), lerp(oy, g.slot.y, glide), lerp(size, SLOT_SIZE, glide)]),
    v3("uRing", [ox, oy, size]),
    f("uFlow", 1.9 * outCubic(seg(t, T.flow))), f("uBloom", outCubic(seg(t, T.bloom))),
    f("uResidue", standard(seg(t, T.residue))), f("uCardOn", standard(seg(t, T.cardOn))),
    f("uSweep", pen + 0.2 * dry), f("uClear", standard(seg(t, T.clear))),
    { name: "uOrigin", type: "vec2", value: [ox, oy] }, f("uScale", 0.55 * Math.max(W, H)),
    { name: "uCard", type: "vec4", value: [...g.card] }, { name: "uPtr", type: "vec4", value: [...looks.stir] },
    f("uBeat", looks.beat), f("uPlate", bow), f("uPlateA", seg(t, [T.bow[0], T.bow[0] + T.bowIn])),
    f("uBowS", 0.92 + 0.08 * bow), f("uKeyA", standard(seg(t, T.key))), f("uIntroNight", looks.night ? 1 : 0),
    v3("uKey", looks.night ? [1, 1, 1] : [10 / 255, 10 / 255, 11 / 255]),
  ];
}

/** The print beat at `k` (0..1 of its run): the card keep-out moves on the standard curve, the plates pulse once. */
export function introBeat(k: number, from: Rect, to: Rect): { card: Rect; pulse: number } {
  const e = standard(k);
  return { card: [lerp(from[0], to[0], e), lerp(from[1], to[1], e), lerp(from[2], to[2], e), lerp(from[3], to[3], e)], pulse: Math.sin(Math.PI * Math.min(1, k)) };
}
