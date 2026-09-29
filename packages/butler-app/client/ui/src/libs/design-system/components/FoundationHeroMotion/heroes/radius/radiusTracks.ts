import type { Key, Pose, Track } from "../../heroTimeline";
import { HOLD, TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { SceneContext } from "../scene/types";
import { LEVELS, RADII, SPECIMEN, specimenRadius, type RadiusCopy } from "./radiusCopy";

/**
 * 05 Radius and elevation, beat marks (1 beat = --motion-deliberate):
 *
 *   0–6.8     Intro     "Radius" and its three lines
 *   6.8–28    Corner    one corner under a ×16 loupe morphs 8 → 10 → 12 → 22 →
 *                       pill, a hold on each; the readout rolls beside it; on the
 *                       pill the camera pulls back (zoom only) for the reveal
 *   28–41.6   Wear      who wears which: on a row of real components an arc
 *                       draws itself clockwise on each real corner in turn, its
 *                       value revealed above on one shared line
 *   41.6–52.1 Nest      inner 8 inside outer 10, concentric; a wrong 22 flashes
 *                       and morphs back
 *   52.1–80.5 Shadows   one scene each, one at a time: a pressed segment rises
 *                       (--shadow-control), a dragged card lifts
 *                       (--shadow-drag-lift), a window opens over the cards
 *                       (--shadow-window); each with when it is used
 */
const MORPH = 2.2;
const STEP = MORPH + HOLD.component;
const AT = { corner: 6.8, morph: 11.8, wear: 28.2, arcs: 32.6, nest: 41.6, wrong: 48.3, press: 52.1, drag: 61.5, over: 71.3, end: 80.5 } as const;
/** When each morph ends (the value it lands on shows from then). */
const lands = RADII.map((_, k) => (k === 0 ? 0 : AT.morph + (k - 1) * STEP + MORPH));
/** Arcs on the row: one every ARC beats, each drawing over DRAW beats. */
const ARC = 1.4;
const DRAW = 1.2;
/** The press and the window open at --motion-fast / --motion-base pace (in beats), the card lifts as SortableCardList (--motion-scale-lift). */
const PRESS = 0.5;
const OPEN = 0.6;
const LIFT = 1.02;

/** Keys that hold at the end and reset to the first pose at the cycle's close. */
function looped(keys: Key[], close: number): Key[] {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
}

export function radiusTracks(copy: RadiusCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { layout, canvas } = g;
    const tall = layout === "tall";
    const spec = SPECIMEN[layout];
    const zoomAt = (cell: string, zoom: number): Pose => view(cell, { x: 0, y: 0, w: canvas.w / zoom, h: canvas.h / zoom }, 1, 99);
    const pillZoom = tall ? 0.46 : 0.62;
    const nestZoom = tall ? 1.8 : 3.2;
    const level = (k: number) => view(["press", "drag", "over"][k]!, g.boxes[`lv-${k}`]!, tall ? 0.8 : 0.62, tall ? 1.7 : 2);
    const camera: Key[] = [
      { at: 0, ...view("intro", g.boxes.intro!, 1, 1) }, { at: AT.corner, ...view("intro", g.boxes.intro!, 1, 1) },
      { at: AT.corner + TRANSITION, ...zoomAt("corner", 1), ease: "standard" }, { at: lands[3]! + HOLD.component, ...zoomAt("corner", 1) },
      { at: lands[4]!, ...zoomAt("corner", pillZoom), ease: "standard" },
      { at: AT.wear, ...zoomAt("corner", pillZoom) }, { at: AT.wear + TRANSITION, ...view("wear", g.boxes.wear!, 0.9, 2), ease: "standard" },
      { at: AT.nest, ...view("wear", g.boxes.wear!, 0.9, 2) }, { at: AT.nest + TRANSITION, ...zoomAt("nest", nestZoom), ease: "standard" },
      { at: AT.press, ...zoomAt("nest", nestZoom) }, { at: AT.press + TRANSITION, ...level(0), ease: "standard" },
      { at: AT.drag, ...level(0) }, { at: AT.drag + TRANSITION, ...level(1), ease: "standard" },
      { at: AT.over, ...level(1) }, { at: AT.over + TRANSITION, ...level(2), ease: "standard" }, { at: AT.end, ...level(2) },
    ];
    // The corner: radius, its inscribed circle and radius line follow each step; on the pill the specimen centres itself.
    const r = (k: number) => specimenRadius(RADII[k]!.px, layout);
    const morph = (pose: (k: number) => Pose): Key[] => [{ at: 0, ...pose(0) }, ...RADII.slice(1).flatMap((_, j): Key[] => [{ at: lands[j + 1]! - MORPH, ...pose(j) }, { at: lands[j + 1]!, ...pose(j + 1), ease: "standard" }])];
    // Tall: the pill settles lower, so the readout above stays inside its round end, clear of the radius line.
    const centre = { x: spec.stage.w / 2 - (spec.corner.x + spec.surface.w / 2), y: spec.stage.h / 2 - (spec.corner.y + spec.surface.h / 2) + (tall ? 120 : 0) };
    const shown = (name: string, from: number, to = close - 0.4): Track => ({
      select: select(name), keys: [{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.5, o: 1, ease: "decelerate" }, { at: to, o: 1 }, { at: to + 0.4, o: 0 }],
    });
    // Each value's names show from its landing until the next (the first from the start).
    const layers = (prefix: string) => RADII.map((_, k): Track => {
      const from = lands[k]!;
      const to = lands[k + 1] ?? close;
      return { select: select(`${prefix}-${k}`), keys: [{ at: 0, o: k === 0 ? 1 : 0 }, { at: Math.max(0.01, from - 0.3), o: k === 0 ? 1 : 0 }, { at: from, o: 1 }, { at: to - 0.3, o: 1 }, { at: to, o: k === RADII.length - 1 ? 1 : 0 }] };
    });
    // The drag: the first card moves down one slot while the second moves up into its place.
    const pitch = (g.boxes["dc-1"]?.y ?? 0) - (g.boxes["dc-0"]?.y ?? 0);
    const lift = AT.drag + TRANSITION + 0.5;
    const move = lift + 1.2;
    const drop = move + 1.8;
    const opens = AT.over + TRANSITION + 0.5;
    const press = AT.press + TRANSITION + 0.6;
    const tracks: Track[] = [
      ...introTracks(copy.title, copy.lead, close),
      { select: select("cs"), keys: looped(morph((k) => ({ rad: r(k) })), close) },
      { select: select("cc"), keys: looped(morph((k) => ({ w: 2 * r(k), h: 2 * r(k) })), close) },
      { select: select("cr"), keys: looped(morph((k) => ({ w: r(k), h: 2, y: r(k) - r(0) })), close) },
      { select: select("cg"), keys: looped([{ at: 0, x: 0, y: 0 }, { at: lands[4]! - MORPH, x: 0, y: 0 }, { at: lands[4]!, ...centre, ease: "standard" }], close) },
      ...rollerTracks("rv", RADII.map((step) => String(step.px)), 0, lands.map((at, k) => [at, k] as [number, number]), g.lines.rv ?? 0, close, MORPH),
      ...layers("rt"), ...layers("rw"), ...reveal("loupe", AT.morph - 0.8, copy.loupe, close),
      // Who wears which: each arc draws clockwise on its corner, then its value reveals above.
      ...[0, 1, 2, 3, 4].flatMap((k): Track[] => {
        const at = AT.arcs + k * ARC;
        return [
          { select: select(`wa-${k}`), keys: looped([{ at: 0, dash: 100, o: 0 }, { at, dash: 100, o: 0 }, { at: at + 0.1, o: 1 }, { at: at + DRAW, dash: 0, ease: "decelerate" }], close) },
          ...reveal(`wv-${k}`, at + DRAW - 0.3, g.chars[`wv-${k}`] ?? 2, close),
        ];
      }),
      // Nesting: the two arcs, the padding between; a wrong inner corner flashes red and morphs back.
      shown("na-o", AT.nest + TRANSITION + 0.4), shown("nn-o", AT.nest + TRANSITION + 0.8), shown("na-i", AT.nest + TRANSITION + 1.2),
      shown("nn-i", AT.nest + TRANSITION + 1.6), shown("np", AT.nest + TRANSITION + 2),
      { select: select("nw"), keys: looped([{ at: 0, o: 0, rad: 8 }, { at: AT.wrong, o: 0, rad: 8 }, { at: AT.wrong + 0.3, o: 1 }, { at: AT.wrong + 1.2, rad: 22, ease: "emphasized" }, { at: AT.wrong + 2.8, rad: 22 }, { at: AT.wrong + 3.8, rad: 8, ease: "standard" }, { at: AT.press - 0.6, o: 1 }, { at: AT.press - 0.1, o: 0 }], close) },
      // Low: the pressed segment takes the raised state (the control's own before and after).
      { select: select("px-0"), keys: looped([{ at: 0, o: 1 }, { at: press, o: 1 }, { at: press + PRESS, o: 0 }], close) },
      { select: select("px-1"), keys: looped([{ at: 0, o: 0 }, { at: press, o: 0 }, { at: press + PRESS, o: 1 }], close) },
      // The drag: lift (scale and shadow), move a slot down as the next card moves up, settle.
      { select: select("dc-0"), keys: looped([{ at: 0, y: 0, s: 1 }, { at: lift, y: 0, s: 1 }, { at: lift + 0.6, s: LIFT, ease: "decelerate" }, { at: move, y: 0 }, { at: move + 1.4, y: pitch }, { at: drop, s: LIFT }, { at: drop + 0.6, s: 1, ease: "standard" }], close) },
      { select: select("dc-1"), keys: looped([{ at: 0, y: 0 }, { at: move + 0.2, y: 0 }, { at: move + 1.4, y: -pitch }], close) },
      { select: select("dshadow"), keys: looped([{ at: 0, o: 0 }, { at: lift, o: 0 }, { at: lift + 0.6, o: 1, ease: "decelerate" }, { at: drop, o: 1 }, { at: drop + 0.6, o: 0 }], close) },
      // High: the window opens over the cards.
      { select: select("win"), keys: looped([{ at: 0, o: 0, s: 0.96 }, { at: opens, o: 0, s: 0.96 }, { at: opens + OPEN, o: 1, s: 1, ease: "decelerate" }], close) },
      // Each shadow's note: when it is used, then its token.
      ...LEVELS.flatMap((item, k): Track[] => {
        const at = [press, lift, opens][k]! + 0.4;
        return [...reveal(`lw-${k}`, at, copy[item.when], close), ...reveal(`lt-${k}`, at + 0.6, item.token, close)];
      }),
    ];
    return { tracks, camera };
  };
}

export const RADIUS_END = AT.end;
export const RADIUS_SPANS = { wear: AT.wear } as const;
