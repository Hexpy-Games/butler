import type { Key, Track } from "../../heroTimeline";
import { motionDuration, type MotionEasingName } from "../../../../lib/motion";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import type { Prelude, TimelineContext } from "../shared/types";
import { DURATIONS, EASES, PLOT, SLOW, type MotionCopy } from "./motionCopy";
import { PLAYS } from "./motionBuilds";

/**
 * 08 Motion prelude, beat marks:
 *
 *   0–7.4     Intro      "Motion"; entrances, exits, restraint
 *   6.8–10.8  Curves     the camera glides to the field; the five easing
 *                        curves draw one by one, a dot running each
 *   16.6–20   Durations  the durations grow as bars in proportion to their
 *                        milliseconds, each exit beside its entrance
 *   20.4–24.4 Reduce     the camera travels on to a toast: it enters with full
 *                        motion (travel and fade), then with reduced motion
 *                        (the fade alone)
 */
const AT = { field: 6.8, curves: 9.8, bars: 16.6, reduce: 20.4, full: 25, less: 27.8, end: 30.4 } as const;
/** Curve length in the plot's 100-unit box (dash). */
const CURVE = 220;
const beatMs = () => motionDuration("deliberate") || 320;

const draw = (name: string, at: number, close: number): Track => ({
  select: select(name), keys: [{ at: 0, dash: CURVE }, { at, dash: CURVE }, { at: at + 1, dash: 0, ease: "decelerate" }, { at: close - 0.01 }, { at: close, dash: CURVE }],
});

/** A dot running a plot: along x in time (linear), along y on the easing itself; it rests at the end. */
export function runTracks(id: string, ease: MotionEasingName, size: number, runs: number[], beats: number, close: number): Track[] {
  const x: Key[] = [{ at: 0, x: 0, o: 0 }];
  const y: Key[] = [{ at: 0, y: 0 }];
  for (const at of runs) {
    x.push({ at: at - 0.01, x: 0, o: 1 }, { at: at + beats, x: size, ease: "linear" });
    y.push({ at: at - 0.01, y: 0 }, { at: at + beats, y: -size, ease });
  }
  return [
    { select: select(`${id}-x`), keys: [...x, { at: close - 0.01 }, { at: close, x: 0, o: 0 }] },
    { select: select(`${id}-y`), keys: [...y, { at: close - 0.01 }, { at: close, y: 0 }] },
  ];
}

export function motionPrelude(copy: MotionCopy): Pick<Prelude, "end" | "tracks"> {
  return {
    end: () => AT.end,
    tracks: ({ g, close, view }: TimelineContext) => {
      const front = view("intro", g.boxes.intro!, 1, 1);
      const field = view("field", g.boxes.field!, 0.9, 2.2);
      const reduce = view("reduce", g.boxes.reduce!, g.layout === "tall" ? 0.94 : 0.7, 2.4);
      const camera: Key[] = [
        { at: 0, ...front }, { at: AT.field, ...front }, { at: AT.field + TRANSITION, ...field, ease: "standard" },
        { at: AT.reduce, ...field }, { at: AT.reduce + TRANSITION, ...reduce, ease: "standard" }, { at: AT.end, ...reduce },
      ];
      const toast = (1.5 * motionDuration("base") * SLOW) / beatMs();
      const cut = (name: string, on: number, off: number): Track => ({ select: select(name), keys: [{ at: 0, o: 0 }, { at: on - 0.01, o: 0 }, { at: on, o: 1 }, { at: off - 0.01, o: 1 }, { at: off, o: 0 }] });
      const tracks: Track[] = [
        ...introTracks(copy.title, copy.lead, close),
        ...reveal("mf-cap", AT.curves - 0.4, 15, close),
        ...EASES.flatMap((ease, k): Track[] => [
          draw(`fp${k}-c`, AT.curves + k * 0.9, close),
          ...reveal(`fp${k}-n`, AT.curves + k * 0.9 + 0.2, ease, close),
          ...runTracks(`fp${k}`, ease, PLOT, [AT.curves + k * 0.9 + 1], 2, close),
        ]),
        ...DURATIONS.flatMap(([enter, exit], k): Track[] => {
          const at = AT.bars + k * 0.45;
          const grow = (name: string, from: number): Track => ({ select: select(name), keys: [{ at: 0, sx: 0 }, { at: from, sx: 0 }, { at: from + 0.8, sx: 1, ease: "decelerate" }, { at: close - 0.01 }, { at: close, sx: 0 }] });
          return [
            ...reveal(`db${k}-n`, at, `--motion-${enter}`, close), grow(`db${k}-e`, at + 0.2),
            ...(exit ? [grow(`db${k}-x`, at + 0.45)] : []), ...reveal(`db${k}-v`, at + 0.7, 12, close),
          ];
        }),
        ...reveal("rm-a-t", AT.reduce + 3, copy.full, close),
        cut("rm-a", 0.01, AT.less), cut("rm-b", AT.less, AT.end + 1),
        ...reveal("rt-t", AT.full, copy.saved, close),
        // Full motion: it drops in over --motion-distance-lg as it fades; reduced: it only fades (slowed three times).
        { select: select("rt"), keys: [
          { at: 0, y: -24, o: 0 }, { at: AT.full - 0.01, y: -24, o: 0 }, { at: AT.full + toast, y: 0, o: 1, ease: "standard" },
          { at: AT.less - 0.6, y: 0, o: 1 }, { at: AT.less - 0.2, o: 0 }, { at: AT.less - 0.01, y: 0, o: 0 }, { at: AT.less + toast, y: 0, o: 1, ease: "standard" },
          { at: close - 0.01 }, { at: close, y: -24, o: 0 },
        ] },
      ];
      return { tracks, camera };
    },
  };
}

/** Each build plays its motion twice (slowed) once its plot is in, the dot running the curve in step. */
export function motionReplays({ builds, close }: TimelineContext): Track[] {
  return Object.entries(PLAYS).flatMap(([id, play]): Track[] => {
    const b = builds[id];
    if (!b) return [];
    const beats = (motionDuration(play.token) * SLOW) / beatMs();
    const first = b.starts[2]! + 0.9;
    const runs = [first, first + beats + 1.2];
    const rest = { o: 1, s: 1, y: 0 };
    const keys: Key[] = [{ at: 0, ...rest }];
    for (const at of runs) {
      if (id === "press") keys.push({ at: at - 0.01, ...rest }, { at: at + beats / 2, s: play.from.s, ease: "accelerate" }, { at: at + beats, s: 1, ease: "standard" });
      else keys.push({ at: at - 0.01, ...rest }, { at, ...rest, ...play.from }, { at: at + beats, ...rest, ease: play.ease });
    }
    return [
      { select: select(`mv-${id}`), keys: [...keys, { at: close - 0.01 }, { at: close, ...rest }] },
      draw(`bp-${id}-c`, b.starts[2]! + 0.2, close),
      ...runTracks(`bp-${id}`, play.ease, 48, runs, beats, close),
    ];
  });
}
