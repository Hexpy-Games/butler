import type { Box, Key, Pose, Track } from "../../heroTimeline";
import { annotTracks } from "./Annotations";
import { HOLD, SETTLE, STEP, TRANSITION } from "./beats";
import { reveal, revealBeats, select, sweep } from "./Reveal";
import { buildFrames, posterZoom } from "./frames";
import { buildViews, fieldAway, REST, scenePath, viewCell } from "./scene";
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
export function chapterTracks(spec: ChapterSpec, g0: Geometry): { beats: number; tracks: Track[]; marks: number[] } {
  const t = schedule(spec, g0);
  const { close } = t;
  const { canvas } = g0;
  const pz = posterZoom(spec, g0.layout);
  const frames = buildFrames(spec, g0);
  // The camera's path: the prelude's scenes, then one cell per build, ending on the last build in place.
  const names = spec.prelude.cells;
  const path = scenePath(names.length + frames.length, center(frames.at(-1)!.frame), canvas);
  const cells = Object.fromEntries(names.map((name, k) => [name, path[k]!])) as Record<string, { x: number; y: number }>;
  const canvasCenter = { x: canvas.w / 2, y: canvas.h / 2 };
  // Regions are laid out over the canvas; the field is laid out in the poster.
  const offset = (cell: string) => {
    const to = cells[cell];
    if (!to) return { x: 0, y: 0 };
    const from = cell === "field" ? center(g0.field) : canvasCenter;
    return { x: to.x - from.x, y: to.y - from.y };
  };
  const g: Geometry = {
    ...g0,
    boxes: Object.fromEntries(Object.entries(g0.boxes).map(([name, box]) => {
      const move = g0.boxCell[name] ? offset(g0.boxCell[name]!) : { x: 0, y: 0 };
      return [name, { ...box, x: box.x + move.x, y: box.y + move.y }];
    })),
  };
  const { shift, stage } = buildViews(g.layout, canvas, frames.map((entry) => entry.frame), path.slice(names.length));
  const buildAt = (k: number) => t.builds[spec.builds[k]!.id]!.at;
  const view = (cell: string, content: Box, fill?: number, cap?: number): Pose => viewCell(canvas, cells[cell] ?? center(content), content, fill, cap);
  const ctx: TimelineContext = { g, cells, view, beats: t.beats, close, first: t.first, builds: t.builds, finale: t.finale, loop: t.loop };
  const prelude = spec.prelude.tracks(ctx);
  const start = prelude.camera[0] ?? { at: 0, ...REST };
  const world: Key[] = [
    ...prelude.camera,
    { at: t.first, ...stage[0]!, ease: "standard" },
    ...spec.builds.slice(1).flatMap((_, j): Key[] => [{ at: buildAt(j + 1) - TRANSITION, ...stage[j]! }, { at: buildAt(j + 1), ...stage[j + 1]!, ease: "standard" }]),
    { at: t.finale, ...stage.at(-1)! }, { at: t.finale + TRANSITION, ...REST, ease: "standard" },
    // The loop cuts back to the opening once the poster has faded (the camera never turns back).
    { at: t.loop + TRANSITION - 0.01, ...REST }, { ...start, at: t.loop + TRANSITION },
  ];
  // Scene regions stand in their cells while the hero plays.
  const regionTracks: Track[] = names.filter((name) => name !== "field").map((name) => ({ select: `[data-cell="${name}"]`, keys: [{ at: 0, ...offset(name), o: 1 }] }));
  // The field shows in its scene cell, waits away while the components build, and gathers onto the poster for the finale.
  const scene = { x: offset("field").x / pz, y: offset("field").y / pz };
  const awayFrom = fieldAway(canvas);
  const away = { x: (awayFrom.x - center(g0.field).x + canvasCenter.x) / pz, y: (awayFrom.y - center(g0.field).y + canvasCenter.y) / pz };
  const fieldTracks: Track[] = [{
    select: select("field-mover"),
    keys: [
      { at: 0, ...scene, o: 1 }, { at: t.first + 0.5, ...scene }, { at: t.first + 0.51, ...away }, { at: t.finale + 0.3, ...away },
      { at: t.finale + 0.3 + TRANSITION, x: 0, y: 0, ease: "standard" }, { at: t.loop, x: 0, y: 0, o: 1 }, { at: t.loop + TRANSITION / 2, o: 0, ease: "accelerate" },
      { at: t.loop + TRANSITION, x: 0, y: 0, o: 0 }, { at: t.loop + TRANSITION + 0.01, ...scene }, { at: close - 0.01 }, { at: close, o: 1 },
    ],
  }];
  const buildTracks = frames.flatMap(({ build, items }, k): Track[] => {
    const b = t.builds[build.id]!;
    const home = t.finale + 0.3 * k;
    const own = { x: shift[k]!.x / pz, y: shift[k]!.y / pz };
    const scheduled = new Set(build.steps.flatMap((step) => [...(step.text ?? []), ...(step.parts ?? [])]));
    const loose = (g.panelOrder[build.id] ?? []).filter((entry) => !scheduled.has(entry.name));
    const fill = b.at + 0.6;
    return [
      ...(own.x || own.y ? [{ select: select(`panel-${build.id}`), keys: [{ at: 0, ...own }, { at: home, ...own }, { at: home + TRANSITION, x: 0, y: 0, ease: "standard" }, { at: t.loop + TRANSITION, x: 0, y: 0 }, { at: t.beats, ...own }] } as Track] : []),
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
    // Beat marks of the scenes (first build, each build done, finale), for reviewing frames.
    marks: [...spec.builds.map((build) => Math.round(t.builds[build.id]!.done * 10) / 10), Math.round((t.finale + TRANSITION + 2) * 10) / 10],
    tracks: [{ select: select("world"), keys: world }, ...regionTracks, ...prelude.tracks, ...fieldTracks, ...buildTracks, ...(spec.extra?.(ctx) ?? [])],
  };
}
