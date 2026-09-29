import { cut, type Box, type Key, type Pose, type Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select as sel } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import { REST, scenePath, viewCell } from "../shared/scene";
import type { SceneGeometry } from "../scene/types";
import { STEPS, type IconCopy } from "./iconCopy";
import { AT, CLOSE, LEAVE, finaleBeats, gridTracks, looped, pullKeys, drawTrack } from "./iconFinale";
import { GLYPH_PATHS, GRID_LENGTH } from "./iconParts";

/** Beats between the label row's size steps. */
const STEP = 2.2;
const GLYPH_DASH = 80;
/** Scene cells sit closer than the shared path's spacing (1.25 canvases): a canvas apart, so the camera crossing always has content in frame. */
const GAP = 0.5;

/** The scenes, in camera order. The grid (the poster) shares the sidebar's cell: the finale zooms in on its centre. */
export const SCENES = ["intro", "glyph", "grow", "place", "grid"] as const;
type Scene = (typeof SCENES)[number];
const PATH: Scene[] = ["intro", "glyph", "grow", "place"];

/**
 * 06 Iconography, "the icon follows the text", beat marks (one beat is
 * --motion-deliberate). Every scene change is one TRANSITION on one axis
 * (right, down, right), and the next scene starts drawing halfway
 * through it, so no frame between scenes is empty. The finale zooms in and
 * out about the frame centre.
 *
 *   0–6.8      Title   the "o" is a glyph: its keyline square, then its circle
 *   6.8–15     Glyph   the 24px keyline grid, padding box and circle draw; the
 *                      gear is drawn stroke by stroke; notes on three sides
 *   15–29.2    Grows   one label row steps caption → body → h4 → h3 → h2; the
 *                      icon swaps xs → md → lg → xl → 2xl on a fixed centre line
 *   29.2–37.2  Place   the app's sidebar: icons pop in row by row, the size
 *                      tag, then a click moves the open row to Settings
 *   37.2–      Grid    the sidebar fades as the camera zooms in on the gear at the
 *                      centre of the icon set; the set draws a diagonal at a time,
 *                      top-left to bottom-right, while the camera pulls out; the
 *                      pull-out ends as the bottom-right glyph finishes; hold
 */

/**
 * Every track of the cycle and the camera. The scene cells stand on a
 * one-axis path ending at the canvas itself (the grid, the poster); the
 * loop fades the grid and cuts back to the opening, as every chapter does.
 */
export function iconTimeline(copy: IconCopy, g0: SceneGeometry): { beats: number; tracks: Track[]; marks: number[] } {
  const { canvas, layout } = g0;
  const tall = layout === "tall";
  const f = finaleBeats(layout);
  const { beats } = f;
  const close = beats - 0.05;
  const path = scenePath(PATH.length, { x: canvas.w / 2, y: canvas.h / 2 }, canvas).map((cell) => ({
    x: canvas.w / 2 + (cell.x - canvas.w / 2) * GAP,
    y: canvas.h / 2 + (cell.y - canvas.h / 2) * GAP,
  }));
  const cells = { ...Object.fromEntries(PATH.map((name, k) => [name, path[k]!])), grid: path.at(-1)! } as Record<Scene, { x: number; y: number }>;
  const offset = (cell: Scene) => ({ x: cells[cell].x - canvas.w / 2, y: cells[cell].y - canvas.h / 2 });
  const boxes: Record<string, Box> = Object.fromEntries(Object.entries(g0.boxes).map(([name, box]) => {
    const cell = g0.boxCell[name] as Scene | undefined;
    const move = cell ? offset(cell) : { x: 0, y: 0 };
    return [name, { ...box, x: box.x + move.x, y: box.y + move.y }];
  }));
  const view = (cell: Scene, fill: number, cap: number): Pose => viewCell(canvas, cells[cell], boxes[cell]!, fill, cap);

  // ---- Camera ----
  const poses = {
    intro: viewCell(canvas, cells.intro, boxes.intro!, 1, 1),
    glyph: view("glyph", 0.8, 2),
    grow: view("grow", tall ? 0.94 : 0.86, 2),
    place: view("place", tall ? 0.9 : 0.86, 2),
    // The sidebar and the grid share the canvas's cell and the gear is its centre: the zoom in and the pull-out are both about the frame's centre (no pan).
    gear: { ...REST, s: CLOSE },
  };
  const world: Key[] = [
    { at: 0, ...poses.intro }, { at: AT.glyph, ...poses.intro }, { at: AT.glyph + TRANSITION, ...poses.glyph, ease: "standard" },
    { at: AT.grow, ...poses.glyph }, { at: AT.grow + TRANSITION, ...poses.grow, ease: "standard" },
    { at: AT.place, ...poses.grow }, { at: AT.place + TRANSITION, ...poses.place, ease: "standard" },
    { at: AT.finale, ...poses.place }, { at: AT.finale + TRANSITION, ...poses.gear, ease: "standard" },
    ...pullKeys(f),
    // The loop cuts back to the opening once the grid has faded (the camera never turns back).
    { at: f.restart - 0.01, ...REST }, { at: f.restart, ...poses.intro },
  ];

  // ---- Scene cells: each on its place of the path; the grid fades out for the loop ----
  const { restart } = f;
  const regions: Track[] = SCENES.map((name) => {
    const keys: Key[] = [{ at: 0, ...offset(name), o: 1 }];
    // The sidebar leaves as the camera heads for the gear, before any glyph under it draws.
    if (name === "place") keys.push({ at: AT.finale, o: 1 }, { at: AT.finale + LEAVE, o: 0, ease: "accelerate" }, { at: restart }, { at: restart + 0.01, o: 1 });
    if (name === "grid") keys.push({ at: f.loop, o: 1 }, { at: f.loop + TRANSITION / 2, o: 0, ease: "accelerate" }, { at: restart }, { at: restart + 0.01, o: 1 });
    return { select: `[data-cell="${name}"]`, keys };
  });

  const draw = (select: string, len: number, at: number, dur: number): Track => drawTrack(select, len, at, dur, close);
  const fade = (name: string, pairs: Array<[number, number]>, first = 0, dur = 0.5): Track => ({
    select: sel(name), keys: looped([{ at: 0, o: first }, ...pairs.flatMap(([at, o]): Key[] => [{ at, o: 1 - o }, { at: at + dur, o, ease: "standard" }])], close),
  });

  // ---- Title: the o's keyline square, then its circle strokes on; the square fades ----
  const title: Track[] = [fade("to-k", [[AT.titleKey, 1], [AT.titleKeyOut, 0]]), draw(sel("to-c"), 100, AT.titleO, 1.2)];

  // ---- Glyph: grid, padding box, circle, then the gear stroke by stroke; one note per side ----
  const glyph: Track[] = [
    draw(sel("kl-grid"), GRID_LENGTH, AT.grid, 1.8), draw(sel("kl-pad"), 80, AT.pad, 1), draw(sel("kl-circle"), 63, AT.circle, 1.1),
    ...Array.from({ length: GLYPH_PATHS }, (_, n) => draw(`${sel("kl-glyph")} path:nth-of-type(${n + 1})`, GLYPH_DASH, AT.strokes + n * 0.5, 1.2)),
    ...reveal("kl-n0", AT.n0, copy.grid, close), ...reveal("kl-n1", AT.n1, copy.padding, close), ...reveal("kl-n2", AT.n2, copy.stroke, close),
  ];

  // ---- Grows with text: icon and word crossfade together at each step; the readouts roll with them ----
  const starts = STEPS.map((_, k) => (k === 0 ? 0 : AT.steps + (k - 1) * STEP));
  const grow: Track[] = STEPS.flatMap((_, k): Track[] => {
    const on = starts[k]!;
    const off = starts[k + 1];
    const pairs: Array<[number, number]> = [...(k > 0 ? [[on - 0.4, 1] as [number, number]] : []), ...(off ? [[off - 0.4, 0] as [number, number]] : [])];
    return [fade(`gi-${k}`, pairs, k === 0 ? 1 : 0, 0.4), fade(`gt-${k}`, pairs, k === 0 ? 1 : 0, 0.4)];
  });
  const times = starts.map((at, k) => [at, k] as [number, number]);
  grow.push(
    // Role and size token cut in the middle of each crossfade.
    ...["grr", "grn"].flatMap((name) => STEPS.map((_, k): Track => ({ select: sel(`${name}-${k}`), keys: cut(k === 0 ? 0 : starts[k]! - 0.2, starts[k + 1] === undefined ? close : starts[k + 1]! - 0.2, beats) }))),
    ...rollerTracks("grp", STEPS.map((step) => String(step.px)), STEPS.length - 1, times, g0.lines.grp ?? 0, close, 0.4),
  );

  // ---- Place: icons pop in (0.85 → 1, --motion-scale-check) row by row; the size tag; the click ----
  const pop = (name: string, at: number): Track => ({ select: sel(name), keys: looped([{ at: 0, s: 0.85, o: 0 }, { at, s: 0.85, o: 0 }, { at: at + 0.5, s: 1, o: 1, ease: "emphasized" }], close) });
  const marks = g0.scopes.pl ?? {};
  const point = (mark: string): Pose => {
    const box = marks[mark]?.box ?? { x: 0, y: 0, w: 100, h: 30 };
    return { x: box.x + box.w * 0.62, y: box.y + box.h * 0.5 };
  };
  const from = point("s0");
  const place: Track[] = [
    ...Array.from({ length: 8 }, (_, k) => pop(`pl-i${k}`, AT.pops + k * 0.22)),
    fade("pl-tag", [[AT.tag, 1]]),
    // The click: the open conversation rests, Settings opens (both real NavRow states, --motion-fast apart).
    fade("pl-s0-on", [[AT.click, 0]], 1, 0.3), fade("pl-s0-rest", [[AT.click, 1]], 0, 0.3),
    fade("pl-set-on", [[AT.click, 1]], 0, 0.3), fade("pl-set-rest", [[AT.click, 0]], 1, 0.3),
    { select: sel("pl-cur"), keys: looped([
      { at: 0, ...from, o: 0, s: 1 }, { at: AT.enter, o: 0 }, { at: AT.enter + 0.4, o: 1, ease: "standard" },
      { at: AT.enter + 0.4, ...from }, { at: AT.arrive, ...point("set"), ease: "standard" },
      { at: AT.click - 0.15, s: 1 }, { at: AT.click, s: 0.85 }, { at: AT.click + 0.3, s: 1, ease: "standard" },
      { at: AT.finale + 1, o: 1 }, { at: AT.finale + 1.6, o: 0, ease: "standard" },
    ], close) },
  ];

  return {
    beats,
    marks: [f.start, f.end],
    tracks: [
      { select: sel("world"), keys: world }, ...regions,
      ...introTracks(copy.title, copy.lead, close), ...title, ...glyph, ...grow, ...place, ...gridTracks(f, close),
    ],
  };
}
