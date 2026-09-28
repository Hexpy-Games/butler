import type { Box, Key, Track } from "../../heroTimeline";
import { annotTracks } from "./Annotations";
import { HOLD, SETTLE, STEP, TRANSITION } from "./beats";
import type { HeroLayout } from "./grid";
import { buildItems, type AnnotItem } from "./guides";
import { reveal, revealBeats, select, sweep } from "./Reveal";
import { BADGE_CHAR, BADGE_GUTTER, badgeReach, buildStages, FIELD_AWAY, REST } from "./scene";
import { sketchTracks } from "./Sketch";
import type { BuildSpec, ChapterSpec, Geometry, TimelineContext } from "./types";

/** The poster's zoom: the wide canvas only (the tall one is full at its own size). */
export function posterZoom(spec: ChapterSpec, layout: HeroLayout): number {
  return layout === "wide" ? spec.posterZoom ?? 1 : 1;
}

/** Everything a build is laid out from: its gutter-framed box and its badge items per step. */
export function buildFrames(spec: ChapterSpec, g: Geometry): Array<{ build: BuildSpec; frame: Box; items: AnnotItem[][] }> {
  const pz = posterZoom(spec, g.layout);
  return spec.builds.map((build) => {
    const panel = g.panels[build.id]!;
    const side = build.side ?? "l";
    const own = { x: 0, y: 0, w: panel.w / pz, h: panel.h / pz };
    const items = buildItems(build.steps.map((step) => step.annots ?? []), g.marks[build.id] ?? {}, `${build.id}-`, own, side, badgeReach(g.layout) / pz, g.layout);
    // The gutter holds the widest badge (estimated from its longest step) at its reach, in canvas px.
    const widest = Math.max(0, ...items.flat().map((item) => (item.badge ? Math.max(...item.badge.text.map((text) => [...text].length)) : 0)));
    const gutter = widest ? Math.max(BADGE_GUTTER[g.layout], (badgeReach(g.layout) / pz + widest * BADGE_CHAR + 24) * pz) : 0;
    const frame = side === "l" ? { ...panel, x: panel.x - gutter, w: panel.w + gutter } : { ...panel, w: panel.w + gutter };
    return { build, frame, items };
  });
}

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

/** Every track of one chapter's cycle, for compileTimeline. */
export function chapterTracks(spec: ChapterSpec, g: Geometry): { beats: number; tracks: Track[] } {
  const t = schedule(spec, g);
  const { close } = t;
  const { canvas } = g;
  const pz = posterZoom(spec, g.layout);
  const frames = buildFrames(spec, g);
  // The field waits off the side it sits on; the stages walk round the other side.
  const { shift, stage } = buildStages(g.layout, canvas, frames.map((entry) => entry.frame), Boolean(spec.fieldRight));
  const buildAt = (k: number) => t.builds[spec.builds[k]!.id]!.at;
  const ctx: TimelineContext = { g, beats: t.beats, close, first: t.first, builds: t.builds, finale: t.finale, loop: t.loop };
  const prelude = spec.prelude.tracks(ctx);
  const start = prelude.camera[0] ?? { at: 0, ...REST };
  const world: Key[] = [
    ...prelude.camera,
    { at: t.first, ...stage[0]!, ease: "standard" },
    ...spec.builds.slice(1).flatMap((_, j): Key[] => [{ at: buildAt(j + 1) - TRANSITION, ...stage[j]! }, { at: buildAt(j + 1), ...stage[j + 1]!, ease: "standard" }]),
    { at: t.finale, ...stage.at(-1)! }, { at: t.finale + TRANSITION, ...REST, ease: "standard" },
    { at: t.loop, ...REST }, { ...start, at: t.loop + TRANSITION, ease: "standard" },
  ];
  // The field waits away while the components build, and gathers back for the finale.
  const away = { x: ((spec.fieldRight ? 1 : -1) * FIELD_AWAY[g.layout] * canvas.w) / pz, y: 0 };
  const fieldTracks: Track[] = [{
    select: select("field-mover"),
    keys: [
      { at: 0, x: 0, y: 0 }, { at: t.first + 0.5, x: 0, y: 0 }, { at: t.first + 0.51, ...away }, { at: t.finale + 0.3, ...away },
      { at: t.finale + 0.3 + TRANSITION, x: 0, y: 0, ease: "standard" }, { at: t.loop, x: 0, y: 0, o: 1 }, { at: t.loop + TRANSITION / 2, o: 0, ease: "accelerate" }, { at: close - 0.01 }, { at: close, o: 1 },
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
    tracks: [{ select: select("world"), keys: world }, ...prelude.tracks, ...fieldTracks, ...buildTracks, ...(spec.extra?.(ctx) ?? [])],
  };
}
