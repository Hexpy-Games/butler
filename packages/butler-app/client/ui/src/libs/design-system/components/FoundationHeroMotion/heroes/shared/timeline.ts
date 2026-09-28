import type { Box, Key, Pose, Track } from "../../heroTimeline";
import { annotTracks } from "./Annotations";
import { HOLD, SETTLE, STEP, TRANSITION } from "./beats";
import { reveal, revealBeats, select, sweep } from "./Reveal";
import { buildFrames, posterZoom } from "./frames";
import { gatherFlights, gatherKeys, visibleBox } from "./gather";
import { introCamera } from "./Intro";
import { buildViews, CELL, columnViews, fieldAway, finalePose, REST, scenePath, viewCell } from "./scene";
import { sketchTracks } from "./Sketch";
import type { ChapterSpec, Geometry, TimelineContext } from "./types";

export { buildFrames, posterZoom };

/** The cycle's beat marks. */
export function schedule(spec: ChapterSpec, g: Geometry) {
  const first = spec.prelude.end(g) + TRANSITION;
  const builds: TimelineContext["builds"] = {};
  let at = first;
  for (const build of spec.builds) {
    const starts = build.steps.reduce<number[]>((list, step, j) => [...list, (j === 0 ? at + 2.4 : list[j - 1]! + (build.steps[j - 1]!.secondary ? STEP.secondary : STEP.main)) + (step.after ?? 0)], []);
    const tail = Math.max(2.4, ...(build.steps.at(-1)?.text ?? []).map((name) => 0.4 + revealBeats(g.chars[name] ?? 8)));
    const done = (starts.at(-1) ?? at + 2.4) + tail;
    builds[build.id] = { at, starts, done, leave: done + HOLD.component - 0.4 };
    at = done + HOLD.component + TRANSITION;
  }
  const finale = builds[spec.builds.at(-1)!.id]!.done + HOLD.component;
  const loop = finale + TRANSITION + SETTLE;
  const beats = loop + TRANSITION + 1.5;
  return { first, builds, finale, loop, beats, close: beats - 0.05 };
}

/**
 * A part appears with its text: it settles in (spring), opens left to right
 * through its window (`g.sweeps`), or its color fades in over its outline
 * (`g.fills`).
 */
function part(name: string, at: number, close: number, g: Pick<Geometry, "sweeps" | "fills">): Track[] {
  if (g.fills.includes(name)) {
    return [{ select: select(`p-${name}`), keys: [{ at: 0, o: 0 }, { at, o: 0 }, { at: at + 1, o: 1, ease: "decelerate" }, { at: close - 0.01 }, { at: close, o: 0 }] }];
  }
  if (g.sweeps.includes(name)) {
    const open = sweep(at, 0.9, close);
    return [{ select: select(`p-${name}`), keys: open.outer }, { select: select(`p-${name}-in`), keys: open.inner }];
  }
  return [{ select: select(`p-${name}`), keys: [{ at: 0, s: 0.9, o: 0 }, { at, s: 0.9, o: 0 }, { at: at + 0.8, s: 1, o: 1, ease: "spring" }, { at: close - 0.01 }, { at: close, s: 0.9, o: 0 }] }];
}

const center = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 });

/** Every track of one chapter's cycle, for compileTimeline. */
export function chapterTracks(spec: ChapterSpec, g0: Geometry): { beats: number; tracks: Track[]; marks: number[]; still: Pose } {
  const t = schedule(spec, g0);
  const { close } = t;
  const { canvas } = g0;
  const pz = posterZoom(spec, g0.layout);
  const frames = buildFrames(spec, g0);
  // The camera's path. Wide: the prelude's scenes, then one cell per build, ending on the last build in
  // place. Tall: the builds stand in the poster's column and the camera steps down it; the prelude's last
  // scene sits right above the first build (the field in its own poster place when it is that scene).
  const names = spec.prelude.cells;
  const tall = g0.layout === "tall";
  const clone = tall && Boolean(spec.fieldScene); // a tall field scene is a region of its own; the poster field stays home
  const canvasCenter = { x: canvas.w / 2, y: canvas.h / 2 };
  const column = columnViews(canvas, frames.map((entry) => entry.frame));
  const lastIsField = names.at(-1) === "field";
  const preludeEnd = lastIsField ? center(g0.field) : { x: column.centers[0]!.x, y: column.centers[0]!.y - CELL * canvas.h };
  const path = tall
    ? [...scenePath(names.length, preludeEnd, canvas), ...column.centers]
    : scenePath(names.length + frames.length, center(frames.at(-1)!.frame), canvas);
  const cells = Object.fromEntries(names.map((name, k) => [name, path[k]!])) as Record<string, { x: number; y: number }>;
  // Regions are laid out over the canvas; the field is laid out in the poster.
  const offset = (cell: string) => {
    const to = cells[cell];
    if (!to) return { x: 0, y: 0 };
    const from = cell === "field" && !clone ? center(g0.field) : canvasCenter;
    return { x: to.x - from.x, y: to.y - from.y };
  };
  const g: Geometry = {
    ...g0,
    boxes: Object.fromEntries(Object.entries(g0.boxes).map(([name, box]) => {
      const move = g0.boxCell[name] ? offset(g0.boxCell[name]!) : { x: 0, y: 0 };
      return [name, { ...box, x: box.x + move.x, y: box.y + move.y }];
    })),
  };
  const { shift, stage } = tall ? column : buildViews(g.layout, canvas, frames.map((entry) => entry.frame), path.slice(names.length));
  const buildAt = (k: number) => t.builds[spec.builds[k]!.id]!.at;
  const view = (cell: string, content: Box, fill?: number, cap?: number): Pose => viewCell(canvas, cells[cell] ?? center(content), content, fill, cap);
  const ctx: TimelineContext = { g, cells, view, beats: t.beats, close, first: t.first, builds: t.builds, finale: t.finale, loop: t.loop };
  const own = spec.prelude.tracks(ctx), prelude = { ...own, camera: introCamera(own.camera) }; // every intro leaves alike
  const start = prelude.camera[0] ?? { at: 0, ...REST };
  const rest = finalePose(g0.layout, canvas, [...(spec.finale?.tall === "product" ? [] : [g0.field]), ...Object.values(g0.panels)]);
  const world: Key[] = [
    ...prelude.camera,
    { at: t.first, ...stage[0]!, ease: "standard" },
    ...spec.builds.slice(1).flatMap((_, j): Key[] => [{ at: buildAt(j + 1) - TRANSITION, ...stage[j]! }, { at: buildAt(j + 1), ...stage[j + 1]!, ease: "standard" }]),
    { at: t.finale, ...stage.at(-1)! }, { at: t.finale + TRANSITION, ...rest, ease: "standard" },
    // The loop cuts back to the opening once the poster has faded (the camera never turns back).
    { at: t.loop + TRANSITION - 0.01, ...rest }, { ...start, at: t.loop + TRANSITION },
  ];
  // Scene regions stand in their cells for the prelude and fade as the camera leaves for the builds.
  const leave = t.first - TRANSITION;
  const regionTracks: Track[] = names.filter((name) => name !== "field" || clone).map((name) => ({
    select: `[data-cell="${name}"]`,
    keys: [{ at: 0, ...offset(name), o: 1 }, { at: leave + 0.2 }, { at: leave + 1, o: 0, ease: "accelerate" }, { at: t.loop + TRANSITION }, { at: t.loop + TRANSITION + 0.01, o: 1 }, { at: close }],
  }));
  // The field shows in its scene cell, waits away during the builds, and gathers with the components (gather.ts).
  const flights = gatherFlights({ field: g0.field, ...g0.panels }, spec.builds.at(-1)!.id, t.finale, visibleBox(canvas, rest));
  const scene = { x: offset("field").x / pz, y: offset("field").y / pz };
  const awayFrom = fieldAway(canvas);
  const away = { x: (awayFrom.x - center(g0.field).x + canvasCenter.x) / pz, y: (awayFrom.y - center(g0.field).y + canvasCenter.y) / pz };
  // On the tall canvas the field comes home once the camera has left its scene (it stands above the builds).
  const home = t.first - TRANSITION - 0.3;
  const fieldTracks: Track[] = clone ? [{
    // The scene condenses into the compact poster field as the camera leaves it.
    select: select("field-mover"),
    keys: [{ at: 0, x: 0, y: 0, o: 0 }, { at: leave + 0.2 }, { at: leave + 1, o: 1, ease: "decelerate" }, { at: t.loop }, { at: t.loop + TRANSITION / 2, o: 0, ease: "accelerate" }, { at: close }],
  }] : tall ? [{
    select: select("field-mover"),
    keys: [
      { at: 0, ...scene, o: 1 }, { at: home - 0.01, ...scene }, { at: home, x: 0, y: 0 }, { at: t.loop, x: 0, y: 0, o: 1 },
      { at: t.loop + TRANSITION / 2, o: 0, ease: "accelerate" }, { at: t.loop + TRANSITION, x: 0, y: 0, o: 0 }, { at: t.loop + TRANSITION + 0.01, ...scene }, { at: close - 0.01 }, { at: close, o: 1 },
    ],
  }] : [{
    select: select("field-mover"),
    keys: [
      { at: 0, ...scene, o: 1 }, { at: t.first + 0.5, ...scene }, { at: t.first + 0.51, ...away }, ...gatherKeys(flights.field!, away, t.finale, pz),
      { at: t.loop, x: 0, y: 0, o: 1 }, { at: t.loop + TRANSITION / 2, o: 0, ease: "accelerate" },
      { at: t.loop + TRANSITION, x: 0, y: 0, o: 0 }, { at: t.loop + TRANSITION + 0.01, ...scene }, { at: close - 0.01 }, { at: close, o: 1 },
    ],
  }];
  const buildTracks = frames.flatMap(({ build, items }, k): Track[] => {
    const b = t.builds[build.id]!;
    const own = { x: shift[k]!.x / pz, y: shift[k]!.y / pz };
    const scheduled = new Set(build.steps.flatMap((step) => [...(step.text ?? []), ...(step.parts ?? [])]));
    const loose = (g.panelOrder[build.id] ?? []).filter((entry) => !scheduled.has(entry.name));
    const fill = b.at + 0.6;
    return [
      ...(own.x || own.y ? [{ select: select(`panel-${build.id}`), keys: [{ at: 0, ...own }, ...gatherKeys(flights[build.id]!, own, t.finale, pz), { at: t.loop + TRANSITION, x: 0, y: 0 }, { at: t.beats, ...own }] } as Track] : []),
      { select: select(`surface-${build.id}`), keys: [{ at: 0, s: 0.98, o: 0 }, { at: fill, s: 0.98, o: 0 }, { at: fill + 1, s: 1, o: 1, ease: "decelerate" }, { at: t.loop + 0.3 * k, o: 1 }, { at: t.loop + TRANSITION / 2 + 0.3 * k, o: 0, ease: "accelerate" }] },
      // The blueprint draws during the travel in and holds until the colors and content are in.
      ...sketchTracks(build.id, g.sketches[build.id] ?? [], b.at - TRANSITION + 0.8, build.holdSketch ? b.done - 0.6 : b.at + 1.6, close),
      ...loose.flatMap((entry, j) => (entry.part ? part(entry.name, fill + 1.2 + j * 0.2, close, g) : reveal(entry.name, fill + 1.2 + j * 0.2, g.chars[entry.name] ?? 8, close))),
      ...build.steps.flatMap((step, j): Track[] => {
        const a = b.starts[j]!;
        return [
          ...(step.parts ?? []).flatMap((name, p) => part(name, a + 0.2 + p * 0.2, close, g)),
          ...(step.text ?? []).flatMap((name, p) => reveal(name, a + 0.4 + p * 0.35, g.chars[name] ?? 8, close)),
          ...(items[j] ?? []).flatMap((item, p) => annotTracks(item, a + p * 0.25, close, b.leave)),
        ];
      }),
    ];
  });
  return {
    beats: t.beats,
    still: rest,
    // Beat marks (each build done, the finale), for reviewing frames.
    marks: [...spec.builds.map((build) => Math.round(t.builds[build.id]!.done * 10) / 10), Math.round((t.finale + TRANSITION + 2) * 10) / 10],
    tracks: [{ select: select("world"), keys: world }, ...regionTracks, ...prelude.tracks, ...fieldTracks, ...buildTracks, ...(spec.extra?.(ctx) ?? [])],
  };
}
