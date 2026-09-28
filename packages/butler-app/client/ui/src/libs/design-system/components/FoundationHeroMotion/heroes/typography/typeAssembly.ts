import type { Key, Pose, Track } from "../../heroTimeline";
import { line, OUT } from "./typeLine";
import type { SpecimenMetrics } from "./specimenMetrics";
import { cameras } from "./typeCamera";
import { BEATS, FINALE, FLIGHTS, LOOP, PANELS, select, specimenTracks, type TypeGeometry } from "./typeChoreography";
import { STRUCTURE } from "./typeLines";
import { sketchTracks } from "./Sketch";
import { revealAll } from "./typeReveals";

/** The list scene ends and the first build starts here; each build takes BUILD beats. */
const FIRST = 34;
const BUILD = 16.5;
/** Beats the camera takes from one component to the next; the next one's blueprint draws during the travel. */
const TRAVEL = 3;

const buildAt = (k: number) => FIRST + k * BUILD;

/** A structural piece that pops in at `at` and leaves with the product. */
function part(name: string, at: number): Track {
  return {
    select: select(name),
    keys: [{ at: 0, s: 0.8, o: 0 }, { at, o: 0 }, { at: at + 0.8, s: 1, o: 1, ease: "spring" }, { at: OUT, o: 1 }, { at: OUT + 0.2, o: 0 }],
  };
}

/** Acts II–IV: the type list, the four builds, the finale, the settle and the loop. */
function assembly(g: TypeGeometry): Track[] {
  const cam = cameras(g);
  const world: Key[] = [
    { at: 0, ...cam.rest }, { at: 18.2, ...cam.rest }, { at: 20.2, ...cam.rest }, { at: 22.2, ...cam.ladder, ease: "emphasized" },
    { at: 23.4, ...cam.top, ease: "emphasized" }, { at: 28.2, ...cam.bottom, ease: "decelerate" }, { at: 31.6, ...cam.bottom }, { at: FIRST, ...cam.stage[0]!, ease: "emphasized" },
    ...PANELS.slice(1).flatMap((_, j): Key[] => [{ at: buildAt(j + 1) - TRAVEL, ...cam.stage[j]! }, { at: buildAt(j + 1), ...cam.stage[j + 1]!, ease: "standard" }]),
    { at: FINALE, ...cam.stage[3]! }, { at: FINALE + 3, ...cam.rest, ease: "emphasized" }, { at: FINALE + 6, ...cam.rest }, { at: FINALE + 9, rx: -0.6, ry: 1.2 }, { at: LOOP - 1, ...cam.rest },
  ];
  // Rungs only move (an opacity animation would flatten their 3D); their
  // parts fade on their own. For the finale they gather in from below-left.
  const rungs = FLIGHTS.flatMap((name, i): Track[] => {
    const rise = 20.6 + i * 0.4;
    const leave = LOOP + i * 0.18;
    const gather = FINALE + 0.3 + i * 0.2;
    const hidden: Pose = { x: 0, y: 40, z: -180 };
    const away: Pose = { x: -80, y: 200, z: 0 };
    const fade = (from: number, to: number, start: Pose = {}, end: Pose = {}): Key[] => [
      { at: 0, o: 0, ...start }, { at: from, o: 0 }, { at: to, o: 1, ease: end.sx ? "emphasized" : "decelerate", ...end }, { at: leave, o: 1 }, { at: leave + 1, o: 0, ease: "accelerate" },
    ];
    const flyIn: Key[] = name === "title" ? [{ at: 0, o: 0 }, { at: 19.4, o: 0, s: 1.3 }, { at: 20.2, o: 1, s: 1, ease: "decelerate" }] : [{ at: 0, o: 0 }, { at: rise - 1, o: 0 }, { at: rise, o: 1, ease: "decelerate" }];
    return [
      {
        select: select(`rung-${name}`),
        keys: [
          { at: 0, ...hidden }, { at: rise - 1.4, ...hidden }, { at: rise, x: 0, y: 0, z: 0, ease: "spring" },
          { at: 40, x: 0, y: 0 }, { at: 40.1, ...away }, { at: gather, ...away }, { at: gather + 2.3, x: 0, y: 0, ease: "emphasized" },
          { at: leave, z: 0 }, { at: leave + 1, z: -60, ease: "accelerate" }, { at: BEATS, ...hidden },
        ],
      },
      { select: select(`chrome-${name}`), keys: fade(rise - 1, rise) },
      { select: select(`band-${name}`), keys: fade(22.4 + i * 0.3, 23.6 + i * 0.3, { sx: 0 }, { sx: 1 }) },
      { select: select(`fly-${name}`), keys: [...flyIn, { at: leave, o: 1 }, { at: leave + 1, o: 0, ease: "accelerate" }] },
    ];
  });
  const digits = g.digits.map((d, k): Track => ({
    select: select(`digit-${k}`),
    keys: [{ at: 0, y: d * g.digitLine }, { at: 28.6 + k * 0.4, y: d * g.digitLine }, { at: 30 + k * 0.4, y: 0, ease: "emphasized" }, { at: OUT, y: 0 }, { at: OUT + 0.4, y: d * g.digitLine }],
  }));
  const builds = PANELS.flatMap((panel, k): Track[] => {
    const at = buildAt(k);
    const shift = cam.shift[panel];
    const home = FINALE + 0.4 * k;
    const lines = g.lines.filter((info) => info.panel === panel);
    // Lines follow one another: a main line gets its own moment, a secondary one a shorter step.
    const starts = lines.reduce<number[]>((list, info, j) => [...list, j === 0 ? at + 2.4 : list[j - 1]! + (lines[j - 1]!.secondary ? 0.6 : 1.3)], []);
    return [
      // The panel only moves (its stage, the gather, the loop); its surface fades in over the blueprint.
      {
        select: select(`panel-${panel}`),
        keys: [
          { at: 0, ...shift }, { at: home, ...shift }, { at: home + 2.6, x: 0, y: 0, ease: "emphasized" },
          { at: LOOP - 0.4 + 0.3 * k, z: 0 }, { at: LOOP + 0.8 + 0.3 * k, z: -200, ease: "accelerate" }, { at: BEATS, ...shift, z: 0 },
        ],
      },
      {
        select: select(`surface-${panel}`),
        keys: [
          { at: 0, s: 0.98, o: 0 }, { at: at + 0.6, s: 0.98, o: 0 }, { at: at + 1.6, s: 1, o: 1, ease: "decelerate" },
          { at: LOOP - 0.4 + 0.3 * k, o: 1 }, { at: LOOP + 0.8 + 0.3 * k, o: 0, ease: "accelerate" },
        ],
      },
      ...sketchTracks(panel, g.sketches[panel], at - TRAVEL + 0.8, at + 1.6),
      ...STRUCTURE[panel].map((name, j) => part(name, at + 1.8 + j * 0.2)),
      ...lines.flatMap((info, j) => line(info, starts[j]!, at + BUILD - TRAVEL - 0.4)),
    ];
  });
  const tnumAt: Pose = { x: g.fly.metric.x - g.tnum.x, y: g.fly.metric.y + g.fly.metric.h + 4 - g.tnum.y };
  return [
    { select: select("world"), keys: world },
    { select: select("cap-tnum"), keys: [{ at: 0, ...tnumAt, y: tnumAt.y! + 6, o: 0 }, { at: 28.2, o: 0 }, { at: 29, y: tnumAt.y, o: 1, ease: "decelerate" }, { at: 31.4, o: 1 }, { at: 32, o: 0, ease: "accelerate" }] },
    ...rungs, ...digits, ...builds,
  ];
}

/** Every track of the cycle, for compileTimeline. */
export function typeTracks(g: TypeGeometry, metrics: SpecimenMetrics): Track[] {
  return [...specimenTracks(g, metrics), ...assembly(g), ...revealAll()];
}
