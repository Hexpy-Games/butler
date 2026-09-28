import type { Key, Pose, Track } from "../../heroTimeline";
import { BEATS, cameras, FLIGHT_AT, FLIGHT_BEATS, FLIGHTS, PANELS, select, typeface, type Flight, type TypeGeometry } from "./typeChoreography";

/** The text a flight lands on; the metric lands on MetricCard's own value. */
export function landSelect(flight: Flight): string {
  return flight === "metric" ? '[data-panel="metric"] [data-slot="metric-value"]' : select(`land-${flight}`);
}

/** A component part that fades and rises in at `at` and leaves with the product. */
function part(selector: string, at: number, from: Pose = { y: 8 }): Track {
  return {
    select: selector,
    keys: [{ at: 0, ...from, o: 0 }, { at, o: 0 }, { at: at + 0.9, x: 0, y: 0, s: 1, o: 1, ease: from.s ? "spring" : "decelerate" }, { at: 62.8, o: 1 }, { at: 63, ...from, o: 0 }],
  };
}

/** Acts II–IV on the measured poster: camera, ladder, numerals, panels, flights, settle and loop. */
function assembly(g: TypeGeometry): Track[] {
  const cam = cameras(g);
  const world: Key[] = [
    { at: 0, ...cam.rest }, { at: 9, s: 1.04, ry: -2.5 }, { at: 11, s: 1.02, ry: 0 }, { at: 13.2, ...cam.rest, ease: "emphasized" },
    { at: 15.6, ...cam.ladderTop, ease: "emphasized" }, { at: 20.6, ...cam.ladderLow }, { at: 23, ...cam.metric, ease: "emphasized" },
    { at: 26, ...cam.metric }, { at: 28.4, ...cam.wide, ease: "emphasized" }, { at: 30.6, ...cam.settings, ease: "emphasized" }, { at: 32.2, ...cam.settings },
    { at: 34.4, ...cam.chat, ease: "emphasized" }, { at: 36.2, ...cam.chat }, { at: 38.4, ...cam.metricPanel, ease: "emphasized" },
    { at: 40, ...cam.metricPanel }, { at: 42, ...cam.composer, ease: "emphasized" }, { at: 44, ...cam.composer },
    { at: 47.5, ...cam.rest, ease: "spring" }, { at: 53, rx: -0.8, ry: 1.6 }, { at: 59, ...cam.rest },
  ];
  // Rungs only move: an opacity animation would flatten them and hide the
  // flying text behind the panels, so each part of a rung fades on its own.
  const rungs = FLIGHTS.flatMap((flight, i): Track[] => {
    const depth = (3 - i) * 16;
    const rise = 13.6 + i * 0.45;
    const leave = 61 + i * 0.18;
    const hidden: Pose = { z: -180, rx: -24 };
    const fade = (from: number, to: number, start: Pose = {}, end: Pose = {}): Key[] => [
      { at: 0, o: 0, ...start }, { at: from, o: 0 }, { at: to, o: 1, ease: end.sx ? "emphasized" : "decelerate", ...end }, { at: leave, o: 1 }, { at: leave + 1, o: 0, ease: "accelerate" },
    ];
    const flyIn: Key[] = flight === "title" ? [{ at: 0, o: 0 }, { at: 12.7, o: 0, s: 1.3 }, { at: 13.5, o: 1, s: 1, ease: "decelerate" }] : [{ at: 0, o: 0 }, { at: rise - 1, o: 0 }, { at: rise, o: 1, ease: "decelerate" }];
    return [
      {
        select: select(`rung-${flight}`),
        keys: [
          { at: 0, ...hidden }, { at: rise - 1.4, ...hidden }, { at: rise, z: 0, rx: 0, ease: "spring" },
          { at: 17 + i * 0.2, z: depth }, { at: 21.5, z: depth }, { at: 23, z: 0, ease: "emphasized" },
          { at: leave, z: 0 }, { at: leave + 1, z: -60, ease: "accelerate" }, { at: BEATS, ...hidden },
        ],
      },
      { select: select(`chrome-${flight}`), keys: fade(rise - 1, rise) },
      { select: select(`band-${flight}`), keys: fade(16 + i * 0.35, 17.2 + i * 0.35, { sx: 0 }, { sx: 1 }) },
      { select: select(`fly-${flight}`), keys: [...flyIn, ...flight_(g, flight, i), { at: leave, o: 1 }, { at: leave + 1, o: 0, ease: "accelerate" }] },
      { select: landSelect(flight), keys: [{ at: 0, o: 0 }, { at: FLIGHT_AT[flight] + 1.9, o: 0 }, { at: FLIGHT_AT[flight] + FLIGHT_BEATS, o: 1 }, { at: 62.8, o: 1 }, { at: 63, o: 0 }] },
    ];
  });
  const digits = g.digits.map((d, k): Track => ({
    select: select(`digit-${k}`),
    keys: [{ at: 0, y: d * g.digitLine }, { at: 22.8 + k * 0.3, y: d * g.digitLine }, { at: 24.8 + k * 0.3, y: 0, ease: "emphasized" }, { at: 62.6, y: 0 }, { at: 63, y: d * g.digitLine }],
  }));
  const panels = PANELS.map((panel, p): Track => {
    const hidden: Pose = { z: -320, ry: 16, o: 0 };
    return {
      select: select(`panel-${panel}`),
      keys: [
        { at: 0, ...hidden }, { at: 26.4 + p * 0.45, ...hidden }, { at: 28.4 + p * 0.45, z: 0, ry: 0, o: 1, ease: "emphasized" },
        { at: 60.6 + p * 0.3, o: 1 }, { at: 61.8 + p * 0.3, z: -200, o: 0, ease: "accelerate" }, { at: BEATS, ...hidden },
      ],
    };
  });
  const words = Array.from({ length: g.words }, (_, k) => part(select(`word-${k}`), 41.2 + k * 0.28));
  const tnum = g.overlays["cap-tnum"];
  const tnumAt: Pose = { x: g.fly.metric.x - tnum.x, y: g.fly.metric.y + g.fly.metric.h + 4 - tnum.y };
  return [
    { select: select("world"), keys: world },
    { select: select("cap-tnum"), keys: [{ at: 0, ...tnumAt, y: tnumAt.y! + 6, o: 0 }, { at: 23, o: 0 }, { at: 23.8, y: tnumAt.y, o: 1, ease: "decelerate" }, { at: 26.2, o: 1 }, { at: 26.8, o: 0, ease: "accelerate" }] },
    ...rungs, ...digits, ...panels, ...words,
    part(select("settings-lead"), 31), part(select("field-hint"), 32.2), part(select("switch"), 32.6, { s: 0.6 }),
    part(select("answer"), 35, { y: 10 }), part('[data-panel="metric"] [data-slot="metric-label"]', 39.8), part('[data-panel="metric"] [data-slot="metric-label"] + *', 40.1),
    part(select("send"), 41.6 + g.words * 0.28, { s: 0.6 }),
  ];
}

/** One rung's text flying into its component: lift toward the camera, land, hand over, return to the poster. */
function flight_(g: TypeGeometry, flight: Flight, i: number): Key[] {
  const f = FLIGHT_AT[flight];
  const dx = g.land[flight].x - g.fly[flight].x;
  const dy = g.land[flight].y - g.fly[flight].y;
  return [
    { at: f, x: 0, y: 0, z: 0, s: 1, o: 1 },
    { at: f + 1, x: dx * 0.45, y: dy * 0.45, z: 90, s: 1.04, ease: "accelerate" },
    { at: f + 1.9, x: dx, y: dy, z: 0, s: 1, ease: "decelerate" },
    { at: f + FLIGHT_BEATS, o: 0 },
    { at: 45, x: 0, y: 0, o: 0 }, { at: 46 + i * 0.15, o: 0 }, { at: 47.4 + i * 0.15, o: 1, ease: "decelerate" },
  ];
}

/** Every track of the cycle, for compileTimeline. */
export function typeTracks(g: TypeGeometry): Track[] {
  return [...typeface(g), ...assembly(g)];
}
