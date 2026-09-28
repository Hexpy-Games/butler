import type { Key, Pose, Track } from "../../heroTimeline";
import { lineDash } from "./LineOverlay";
import type { SpecimenMetrics } from "./specimenMetrics";
import { cameras } from "./typeCamera";
import { BEATS, FINALE, FLIGHTS, LOOP, PANELS, select, specimenTracks, type TypeGeometry } from "./typeChoreography";
import { BADGE_ROW, STRUCTURE, type LineInfo } from "./typeLines";

/** The list scene ends and the first build starts here; each build takes BUILD beats. */
const FIRST = 31.4;
const BUILD = 7;
/** Built text leaves at the loop from here. */
const OUT = LOOP + 1.3;

const buildAt = (k: number) => FIRST + k * BUILD;



/** While a component builds, a piece sits `drop` px lower (a badge row per text line above it), then settles into place. */
function settle(drop: number, leave: number): Key[] {
  return [{ at: 0, y: drop }, { at: leave, y: drop }, { at: leave + 1, y: 0, ease: "emphasized" }, { at: BEATS - 0.1, y: drop }];
}

/** A structural piece that pops in at `at`, makes room like the lines above it, and leaves with the product. */
function part(name: string, at: number, drop: number, leave: number): Track {
  return {
    select: select(name),
    keys: [{ at: 0, s: 0.8, o: 0 }, { at, o: 0 }, { at: at + 0.8, s: 1, o: 1, ease: "spring" }, { at: OUT, o: 1 }, { at: OUT + 0.2, o: 0 }, ...settle(drop, leave)],
  };
}

/** One text line: token badge, baseline rule drawn left to right, outline drawn along its contours, then the real text fills in. */
function line(info: LineInfo, at: number, leave: number, drop: number): Track[] {
  const badge: Track = { select: select(`lb-${info.id}`), keys: [{ at: 0, y: 6, o: 0 }, { at, o: 0 }, { at: at + 0.6, y: 0, o: 1, ease: "decelerate" }, { at: leave, o: 1 }, { at: leave + 0.6, o: 0, ease: "accelerate" }] };
  // While it builds, the line sits `drop` px lower (room for its badge above it), then settles into place.
  const fill = (from: number, to: number): Track => ({ select: info.select, keys: [{ at: 0, o: 0 }, { at: from, o: 0 }, { at: to, o: 1, ease: "decelerate" }, { at: OUT, o: 1 }, { at: OUT + 0.2, o: 0 }, ...settle(drop, leave)] });
  const layer: Track = { select: select(`lx-${info.id}`), keys: settle(drop, leave) };
  if (!info.draw) return [badge, layer, fill(at + 0.6, at + 1.6)];
  const dash = lineDash(info);
  return [
    badge,
    layer,
    { select: select(`lr-${info.id}`), keys: [{ at: 0, sx: 0, o: 0 }, { at: at + 0.2, sx: 0, o: 1 }, { at: at + 1.4, sx: 1, ease: "decelerate" }, { at: at + 2.4, o: 1 }, { at: at + 3, o: 0, ease: "accelerate" }] },
    { select: select(`lo-${info.id}`), keys: [{ at: 0, dash, o: 0 }, { at: at + 0.3, o: 1 }, { at: at + 2.1, dash: 0 }, { at: at + 2.2, o: 1 }, { at: at + 2.8, o: 0, ease: "accelerate" }, { at: BEATS - 0.1, dash }] },
    fill(at + 1.8, at + 2.4),
  ];
}

/** Acts II–IV: the type list, the four builds, the finale, the settle and the loop. */
function assembly(g: TypeGeometry): Track[] {
  const cam = cameras(g);
  const world: Key[] = [
    { at: 0, ...cam.rest }, { at: 18.2, ...cam.rest }, { at: 20.2, ...cam.rest }, { at: 22.2, ...cam.ladder, ease: "emphasized" },
    { at: 23.4, ...cam.top, ease: "emphasized" }, { at: 28.6, ...cam.bottom, ease: "linear" }, { at: FIRST, ...cam.stage[0]!, ease: "decelerate" },
    ...PANELS.slice(1).flatMap((_, j): Key[] => [{ at: buildAt(j + 1) - 1.4, ...cam.stage[j]! }, { at: buildAt(j + 1), ...cam.stage[j + 1]!, ease: "emphasized" }]),
    { at: FINALE, ...cam.stage[3]! }, { at: FINALE + 3, ...cam.rest, ease: "emphasized" }, { at: FINALE + 6, ...cam.rest }, { at: 70, rx: -0.6, ry: 1.2 }, { at: LOOP - 1, ...cam.rest },
  ];
  // Rungs only move (an opacity animation would flatten their 3D); their
  // parts fade on their own. For the finale they gather in from below-left.
  const rungs = FLIGHTS.flatMap((name, i): Track[] => {
    const rise = 20.6 + i * 0.4;
    const leave = LOOP + i * 0.18;
    const gather = FINALE + 0.3 + i * 0.2;
    const hidden: Pose = { x: 0, y: 0, z: -180, rx: -24 };
    const away: Pose = { x: -80, y: 200, z: 0, rx: 0 };
    const fade = (from: number, to: number, start: Pose = {}, end: Pose = {}): Key[] => [
      { at: 0, o: 0, ...start }, { at: from, o: 0 }, { at: to, o: 1, ease: end.sx ? "emphasized" : "decelerate", ...end }, { at: leave, o: 1 }, { at: leave + 1, o: 0, ease: "accelerate" },
    ];
    const flyIn: Key[] = name === "title" ? [{ at: 0, o: 0 }, { at: 19.4, o: 0, s: 1.3 }, { at: 20.2, o: 1, s: 1, ease: "decelerate" }] : [{ at: 0, o: 0 }, { at: rise - 1, o: 0 }, { at: rise, o: 1, ease: "decelerate" }];
    return [
      {
        select: select(`rung-${name}`),
        keys: [
          { at: 0, ...hidden }, { at: rise - 1.4, ...hidden }, { at: rise, x: 0, y: 0, z: 0, rx: 0, ease: "spring" },
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
    keys: [{ at: 0, y: d * g.digitLine }, { at: 26.6 + k * 0.3, y: d * g.digitLine }, { at: 28.4 + k * 0.3, y: 0, ease: "emphasized" }, { at: OUT, y: 0 }, { at: OUT + 0.4, y: d * g.digitLine }],
  }));
  const builds = PANELS.flatMap((panel, k): Track[] => {
    const at = buildAt(k);
    const shift = cam.shift[panel];
    const home = FINALE + 0.4 * k;
    const hidden: Pose = { ...shift, s: 0.96, o: 0 };
    const lines = g.lines.filter((info) => info.panel === panel);
    return [
      {
        select: select(`panel-${panel}`),
        keys: [
          { at: 0, ...hidden }, { at: at - 0.2, ...hidden }, { at: at + 1, s: 1, o: 1, ease: "emphasized" },
          { at: home, ...shift }, { at: home + 2.6, x: 0, y: 0, ease: "emphasized" },
          { at: LOOP - 0.4 + 0.3 * k, z: 0, o: 1 }, { at: LOOP + 0.8 + 0.3 * k, z: -200, o: 0, ease: "accelerate" }, { at: BEATS, ...hidden, z: 0 },
        ],
      },
      ...STRUCTURE[panel].map((name, j) => part(name, at + 0.8 + j * 0.2, BADGE_ROW * lines.filter((info) => info.box.y < (g.parts[name] ?? 0)).length, at + BUILD - 2.2)),
      ...lines.flatMap((info, j) => line(info, at + 1.2 + j * 0.4, at + BUILD - 2.2, j * BADGE_ROW)),
    ];
  });
  const tnumAt: Pose = { x: g.fly.metric.x - g.tnum.x, y: g.fly.metric.y + g.fly.metric.h + 4 - g.tnum.y };
  return [
    { select: select("world"), keys: world },
    { select: select("cap-tnum"), keys: [{ at: 0, ...tnumAt, y: tnumAt.y! + 6, o: 0 }, { at: 26.6, o: 0 }, { at: 27.4, y: tnumAt.y, o: 1, ease: "decelerate" }, { at: 29.4, o: 1 }, { at: 30, o: 0, ease: "accelerate" }] },
    ...rungs, ...digits, ...builds,
  ];
}

/** Every track of the cycle, for compileTimeline. */
export function typeTracks(g: TypeGeometry, metrics: SpecimenMetrics): Track[] {
  return [...specimenTracks(g, metrics), ...assembly(g)];
}
