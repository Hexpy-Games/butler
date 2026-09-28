import { fit, focus, type Key, type Pose, type Track } from "../../heroTimeline";
import { HOLD, TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { SceneContext } from "../scene/types";
import { LEVELS, RADII, SPECIMEN, specimenRadius, type RadiusCopy } from "./radiusCopy";

/**
 * 05 Radius and elevation, beat marks (1 beat = --motion-deliberate):
 *
 *   0–7.4     Intro     "Radius", a control-radius outline drawing behind the R
 *   6.8–28    Corner    one corner under a ×16 loupe morphs 8 → 10 → 12 → 22 →
 *                       pill, a hold on each; the readout rolls beside it; on the
 *                       pill the camera pulls back (zoom only) for the reveal
 *   28–41     Wear      who wears which: a ghost arc lands on each corner of a
 *                       row of real components, its value set above each
 *   41–51.6   Nest      inner 8 inside outer 10, concentric; a wrong 22 flashes
 *                       and morphs back
 *   51.6–66.8 Floor     cut to a quarter view: three surfaces rise in turn off
 *                       a floor, their shadows widening; the camera untilts
 */
const MORPH = 2.2;
const STEP = MORPH + HOLD.component;
const AT = { corner: 6.8, morph: 11.8, wear: 28.2, tour: 32.8, nest: 41.1, wrong: 47.8, floor: 51.6, rise: 52.6, untilt: 61.6, end: 66.8 } as const;
/** When each morph ends (the value it lands on shows from then). */
const lands = RADII.map((_, k) => (k === 0 ? 0 : AT.morph + (k - 1) * STEP + MORPH));
/** The quarter view of the floor (as the Color field). */
const QUARTER = { rx: 55, rz: -40 } as const;

/** Keys that hold at the end and reset to the first pose at the cycle's close. */
function looped(keys: Key[], close: number): Key[] {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
}

export function radiusTracks(copy: RadiusCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { layout, canvas } = g;
    const spec = SPECIMEN[layout];
    const zoomAt = (cell: string, zoom: number): Pose => view(cell, { x: 0, y: 0, w: canvas.w / zoom, h: canvas.h / zoom }, 1, 99);
    const floor = g.boxes.floor!;
    const quarter = focus(canvas, floor, fit(canvas, floor, layout === "tall" ? 1.2 : 0.95, 1.6), QUARTER);
    const pillZoom = layout === "tall" ? 0.46 : 0.62;
    const camera: Key[] = [
      { at: 0, ...view("intro", g.boxes.intro!, 1, 1) }, { at: AT.corner, ...view("intro", g.boxes.intro!, 1, 1) },
      { at: AT.corner + TRANSITION, ...zoomAt("corner", 1), ease: "standard" }, { at: lands[3]! + HOLD.component, ...zoomAt("corner", 1) },
      { at: lands[4]!, ...zoomAt("corner", pillZoom), ease: "standard" },
      { at: AT.wear, ...zoomAt("corner", pillZoom) }, { at: AT.wear + TRANSITION, ...view("wear", g.boxes.wear!, 0.9, 2), ease: "standard" },
      { at: AT.nest, ...view("wear", g.boxes.wear!, 0.9, 2) }, { at: AT.nest + TRANSITION, ...zoomAt("nest", layout === "tall" ? 1.8 : 3.2), ease: "standard" },
      // A clean cut to the floor in quarter view; it untilts to the front once the three have risen.
      { at: AT.floor - 0.01, ...zoomAt("nest", layout === "tall" ? 1.8 : 3.2) }, { at: AT.floor, ...quarter },
      { at: AT.untilt, ...quarter }, { at: AT.untilt + TRANSITION, ...view("floor", floor, 0.85, 1.6), ease: "standard" }, { at: AT.end, ...view("floor", floor, 0.85, 1.6) },
    ];
    // The corner: radius, its inscribed circle and radius line follow each step; on the pill the specimen centres itself.
    const r = (k: number) => specimenRadius(RADII[k]!.px, layout);
    const morph = (pose: (k: number) => Pose): Key[] => [{ at: 0, ...pose(0) }, ...RADII.slice(1).flatMap((_, j): Key[] => [{ at: lands[j + 1]! - MORPH, ...pose(j) }, { at: lands[j + 1]!, ...pose(j + 1), ease: "standard" }])];
    const centre = { x: spec.stage.w / 2 - (spec.corner.x + spec.surface.w / 2), y: spec.stage.h / 2 - (spec.corner.y + spec.surface.h / 2) };
    const shown = (name: string, from: number, to = close - 0.4): Track => ({
      select: select(name), keys: [{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.5, o: 1, ease: "decelerate" }, { at: to, o: 1 }, { at: to + 0.4, o: 0 }],
    });
    // Each value's names show from its landing until the next (the first from the start).
    const layers = (prefix: string) => RADII.map((_, k): Track => {
      const from = lands[k]!;
      const to = lands[k + 1] ?? close;
      return { select: select(`${prefix}-${k}`), keys: [{ at: 0, o: k === 0 ? 1 : 0 }, { at: Math.max(0.01, from - 0.3), o: k === 0 ? 1 : 0 }, { at: from, o: 1 }, { at: to - 0.3, o: 1 }, { at: to, o: k === RADII.length - 1 ? 1 : 0 }] };
    });
    const wear = [0, 1, 2, 3, 4].map((k) => {
      const m = g.scopes.wear?.[`w${k}`];
      const radius = Math.min(m?.r ?? 8, (m?.box.h ?? 16) / 2);
      return { at: AT.tour + k * 1.7, pose: { x: m?.box.x ?? 0, y: m?.box.y ?? 0, w: radius + 10, h: radius + 10, rad: radius } as Pose };
    });
    const tracks: Track[] = [
      ...introTracks(copy.title, copy.lead, close),
      { select: select("dec"), keys: looped([{ at: 0, dash: 100 }, { at: 1, dash: 100 }, { at: 3, dash: 0, ease: "decelerate" }], close) },
      { select: select("cs"), keys: looped(morph((k) => ({ rad: r(k) })), close) },
      { select: select("cc"), keys: looped(morph((k) => ({ w: 2 * r(k), h: 2 * r(k) })), close) },
      { select: select("cr"), keys: looped(morph((k) => ({ w: r(k), h: 2, y: r(k) - r(0) })), close) },
      { select: select("cg"), keys: looped([{ at: 0, x: 0, y: 0 }, { at: lands[4]! - MORPH, x: 0, y: 0 }, { at: lands[4]!, ...centre, ease: "standard" }], close) },
      ...rollerTracks("rv", RADII.map((step) => String(step.px)), 0, lands.map((at, k) => [at, k] as [number, number]), g.lines.rv ?? 0, close, MORPH),
      ...layers("rt"), ...layers("rw"), ...reveal("loupe", AT.morph - 0.8, copy.loupe, close),
      // Who wears which: the ghost arc tours the row, landing on each top-left corner; the value shows above on arrival.
      shown("ghost", AT.tour - 0.6, AT.nest),
      { select: select("ghost"), keys: looped([{ at: 0, ...wear[0]!.pose }, ...wear.slice(1).flatMap((stop, k): Key[] => [{ at: stop.at - 0.9, ...wear[k]!.pose }, { at: stop.at, ...stop.pose, ease: "standard" }])], close) },
      ...wear.map((stop, k) => shown(`wv-w${k}`, stop.at)),
      // Nesting: the two arcs, the padding between; a wrong inner corner flashes red and morphs back.
      shown("na-o", AT.nest + TRANSITION + 0.4), shown("nn-o", AT.nest + TRANSITION + 0.8), shown("na-i", AT.nest + TRANSITION + 1.2),
      shown("nn-i", AT.nest + TRANSITION + 1.6), shown("np", AT.nest + TRANSITION + 2),
      { select: select("nw"), keys: looped([{ at: 0, o: 0, rad: 8 }, { at: AT.wrong, o: 0, rad: 8 }, { at: AT.wrong + 0.3, o: 1 }, { at: AT.wrong + 1.2, rad: 22, ease: "emphasized" }, { at: AT.wrong + 2.8, rad: 22 }, { at: AT.wrong + 3.8, rad: 8, ease: "standard" }, { at: AT.floor - 0.6, o: 1 }, { at: AT.floor - 0.1, o: 0 }], close) },
      // Elevation: one surface at a time rises to its level; its floor shadow widens and softens; the post measures the height.
      ...LEVELS.flatMap((level, k): Track[] => {
        const at = AT.rise + k * 3.3;
        return [
          { select: select(`fl-${k}`), keys: looped([{ at: 0, z: 0 }, { at, z: 0 }, { at: at + 1.4, z: level.rise, ease: "standard" }], close) },
          { select: select(`fs-${k}`), keys: looped([{ at: 0, s: 0.92, o: 0.3 }, { at, s: 0.92, o: 0.3 }, { at: at + 1.4, s: 1.12, o: 1, ease: "standard" }, { at: AT.untilt, s: 1.12, o: 1 }, { at: AT.untilt + 1.4, o: 0 }], close) },
          { select: select(`fp-${k}`), keys: looped([{ at: 0, sy: 0, o: 0 }, { at, sy: 0, o: 0 }, { at: at + 0.2, o: 1 }, { at: at + 1.4, sy: 1, ease: "standard" }, { at: AT.untilt, sy: 1, o: 1 }, { at: AT.untilt + 1, o: 0 }], close) },
          shown(`fn-${k}`, at + 1.4),
        ];
      }),
    ];
    return { tracks, camera };
  };
}

export const RADIUS_END = AT.end;
export const RADIUS_SPANS = { wear: AT.wear } as const;
