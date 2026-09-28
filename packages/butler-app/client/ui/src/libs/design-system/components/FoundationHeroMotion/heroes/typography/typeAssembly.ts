import type { Key, Pose, Track } from "../../heroTimeline";
import type { SpecimenMetrics } from "./specimenMetrics";
import { cameras } from "./typeCamera";
import { BEATS, FLIGHTS, PANELS, select, specimenTracks, type Flight, type TypeGeometry } from "./typeChoreography";

/** When each role's text leaves its rung (beats); it lands 2.2 beats later, inside the example the camera holds. */
const FLIGHT_AT: Record<Flight, number> = { title: 32.2, field: 33.2, ask: 37.8, command: 38.8, meta: 39.8, dash: 43.4, metric: 44.2 };
const FLIGHT_BEATS = 2.2;
/** Everything leaves at the loop from here. */
const OUT = 73.3;

/** The text a flight lands on; the metric lands on the first MetricCard's own value. */
export function landSelect(flight: Flight): string {
  return flight === "metric" ? '[data-panel="metric"] [data-slot="metric-value"]:not([data-t="metric-2"] *)' : select(`land-${flight}`);
}

/** A component part that fades and rises in at `at` and leaves with the product. */
function part(selector: string, at: number, from: Pose = { y: 8 }): Track {
  return {
    select: selector,
    keys: [{ at: 0, ...from, o: 0 }, { at, o: 0 }, { at: at + 0.9, x: 0, y: 0, s: 1, o: 1, ease: from.s ? "spring" : "decelerate" }, { at: OUT, o: 1 }, { at: OUT + 0.2, ...from, o: 0 }],
  };
}

/** One role's text flying into its component: lift toward the camera, land, hand over, return to the poster. */
function flight(g: TypeGeometry, name: Flight, i: number): Key[] {
  const f = FLIGHT_AT[name];
  const dx = g.land[name].x - g.fly[name].x;
  const dy = g.land[name].y - g.fly[name].y;
  return [
    { at: f, x: 0, y: 0, z: 0, s: 1, o: 1 },
    { at: f + 1, x: dx * 0.45, y: dy * 0.45, z: 90, s: 1.04, ease: "accelerate" },
    { at: f + 1.9, x: dx, y: dy, z: 0, s: 1, ease: "decelerate" },
    { at: f + FLIGHT_BEATS, o: 0 },
    { at: 54.4, x: 0, y: 0, o: 0 }, { at: 55 + i * 0.15, o: 0 }, { at: 56.4 + i * 0.15, o: 1, ease: "decelerate" },
  ];
}

/** Acts II–IV on the measured poster: camera, ladder, numerals, panels, flights, settle and loop. */
function assembly(g: TypeGeometry): Track[] {
  const cam = cameras(g);
  const world: Key[] = [
    { at: 0, ...cam.rest }, { at: 18.2, ...cam.rest }, { at: 20.2, ...cam.rest }, { at: 22.4, ...cam.ladder, ease: "emphasized" },
    { at: 26, ...cam.ladderDolly }, { at: 27.2, ...cam.metric, ease: "emphasized" }, { at: 29.8, ...cam.metric },
    { at: 31.2, ...cam.wide, ease: "emphasized" }, { at: 31.8, ...cam.wide },
    { at: 33, ...cam.settings, ease: "emphasized" }, { at: 37, ...cam.settings },
    { at: 38.4, ...cam.chat, ease: "emphasized" }, { at: 42.8, ...cam.chat },
    { at: 44.2, ...cam.metricPanel, ease: "emphasized" }, { at: 48.4, ...cam.metricPanel },
    { at: 49.8, ...cam.composer, ease: "emphasized" }, { at: 53, ...cam.composer },
    { at: 56, ...cam.rest, ease: "spring" }, { at: 63, rx: -0.8, ry: 1.4 }, { at: 70, ...cam.rest },
  ];
  // Rungs only move: an opacity animation would flatten them and hide the
  // flying text behind the panels, so each part of a rung fades on its own.
  const rungs = FLIGHTS.flatMap((name, i): Track[] => {
    const depth = (3 - i) * 14;
    const rise = 20.6 + i * 0.4;
    const leave = 72 + i * 0.18;
    const hidden: Pose = { z: -180, rx: -24 };
    const fade = (from: number, to: number, start: Pose = {}, end: Pose = {}): Key[] => [
      { at: 0, o: 0, ...start }, { at: from, o: 0 }, { at: to, o: 1, ease: end.sx ? "emphasized" : "decelerate", ...end }, { at: leave, o: 1 }, { at: leave + 1, o: 0, ease: "accelerate" },
    ];
    const flyIn: Key[] = name === "title" ? [{ at: 0, o: 0 }, { at: 19.4, o: 0, s: 1.3 }, { at: 20.2, o: 1, s: 1, ease: "decelerate" }] : [{ at: 0, o: 0 }, { at: rise - 1, o: 0 }, { at: rise, o: 1, ease: "decelerate" }];
    return [
      {
        select: select(`rung-${name}`),
        keys: [
          { at: 0, ...hidden }, { at: rise - 1.4, ...hidden }, { at: rise, z: 0, rx: 0, ease: "spring" },
          { at: 23 + i * 0.2, z: depth }, { at: 25.6, z: depth }, { at: 26.8, z: 0, ease: "emphasized" },
          { at: leave, z: 0 }, { at: leave + 1, z: -60, ease: "accelerate" }, { at: BEATS, ...hidden },
        ],
      },
      { select: select(`chrome-${name}`), keys: fade(rise - 1, rise) },
      { select: select(`band-${name}`), keys: fade(22.6 + i * 0.3, 23.8 + i * 0.3, { sx: 0 }, { sx: 1 }) },
      { select: select(`fly-${name}`), keys: [...flyIn, ...flight(g, name, i), { at: leave, o: 1 }, { at: leave + 1, o: 0, ease: "accelerate" }] },
      { select: landSelect(name), keys: [{ at: 0, o: 0 }, { at: FLIGHT_AT[name] + 1.9, o: 0 }, { at: FLIGHT_AT[name] + FLIGHT_BEATS, o: 1 }, { at: OUT, o: 1 }, { at: OUT + 0.2, o: 0 }] },
    ];
  });
  const digits = g.digits.map((d, k): Track => ({
    select: select(`digit-${k}`),
    keys: [{ at: 0, y: d * g.digitLine }, { at: 27 + k * 0.3, y: d * g.digitLine }, { at: 29 + k * 0.3, y: 0, ease: "emphasized" }, { at: OUT, y: 0 }, { at: OUT + 0.4, y: d * g.digitLine }],
  }));
  const panels = PANELS.map((panel, p): Track => {
    const hidden: Pose = { z: -320, ry: 16, o: 0 };
    return {
      select: select(`panel-${panel}`),
      keys: [
        { at: 0, ...hidden }, { at: 29.8 + p * 0.4, ...hidden }, { at: 31.6 + p * 0.4, z: 0, ry: 0, o: 1, ease: "emphasized" },
        { at: 71.6 + p * 0.3, o: 1 }, { at: 72.8 + p * 0.3, z: -200, o: 0, ease: "accelerate" }, { at: BEATS, ...hidden },
      ],
    };
  });
  const words = Array.from({ length: g.words }, (_, k) => part(select(`word-${k}`), 49.8 + k * 0.28));
  const tnumAt: Pose = { x: g.fly.metric.x - g.tnum.x, y: g.fly.metric.y + g.fly.metric.h + 4 - g.tnum.y };
  return [
    { select: select("world"), keys: world },
    { select: select("cap-tnum"), keys: [{ at: 0, ...tnumAt, y: tnumAt.y! + 6, o: 0 }, { at: 27.2, o: 0 }, { at: 28, y: tnumAt.y, o: 1, ease: "decelerate" }, { at: 29.8, o: 1 }, { at: 30.4, o: 0, ease: "accelerate" }] },
    ...rungs, ...digits, ...panels, ...words,
    part(select("settings-lead"), 34.6), part(select("field-hint"), 35.6), part(select("switch"), 35.8, { s: 0.6 }), part(select("field-2"), 36.1),
    part(select("answer"), 40.6, { y: 10 }),
    part('[data-panel="metric"] [data-slot="metric-label"]:not([data-t="metric-2"] *)', 46.5), part('[data-panel="metric"] [data-slot="metric-label"]:not([data-t="metric-2"] *) + *', 46.8), part(select("metric-2"), 47.1),
    part(select("send"), 50.2 + g.words * 0.28, { s: 0.6 }),
  ];
}

/** Every track of the cycle, for compileTimeline. */
export function typeTracks(g: TypeGeometry, metrics: SpecimenMetrics): Track[] {
  return [...specimenTracks(g, metrics), ...assembly(g)];
}
