import type { Key, Pose, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { SceneContext } from "../scene/types";
import { STEPS, type IconCopy } from "./iconCopy";
import { GLYPH_PATHS, GRID_LENGTH } from "./iconTiles";

/**
 * 06 Iconography, "the icon follows the text", beat marks:
 *
 *   0–7.4     Title   the "o" strokes on as a glyph's circle on its keyline
 *   6.8–15.6  Glyph   the 24px keyline grid, padding box and circle draw;
 *                     the gear is drawn stroke by stroke; notes on three sides
 *   15.6–31.4 Grows   one label row steps caption → body → h4 → h3 → h2; the
 *                     icon swaps xs → md → lg → xl → 2xl on a fixed centre line
 *   31.4–44.4 Place   a sidebar and a toolbar: icons pop in row by row; one
 *                     tone pass follows a cursor (muted → primary → accent)
 */
const AT = { glyph: 6.8, grid: 10.2, strokes: 12.2, grow: 15.6, steps: 20.2, place: 31.4, pops: 35.6, tools: 37, tag: 38, enter: 38.8, h1: 39.8, h2: 41.2, click: 42.4, end: 44.4 } as const;
const STEP = 2.2;
const GLYPH_DASH = 80;

const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

export function iconTracks(copy: IconCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const tall = g.layout === "tall";
    const poses = {
      intro: view("intro", g.boxes.intro!, 1, 1), glyph: view("glyph", g.boxes.glyph!, tall ? 0.94 : 0.86, 2),
      grow: view("grow", g.boxes.grow!, 0.86, 2), place: view("place", g.boxes.place!, 0.86, 2),
    };
    const camera: Key[] = [
      { at: 0, ...poses.intro }, { at: AT.glyph, ...poses.intro }, { at: AT.glyph + TRANSITION, ...poses.glyph, ease: "standard" },
      { at: AT.grow, ...poses.glyph }, { at: AT.grow + TRANSITION, ...poses.grow, ease: "standard" },
      { at: AT.place, ...poses.grow }, { at: AT.place + TRANSITION, ...poses.place, ease: "standard" }, { at: AT.end, ...poses.place },
    ];
    const draw = (sel: string, len: number, at: number, beats: number): Track => ({ select: sel, keys: looped([{ at: 0, dash: len }, { at, dash: len }, { at: at + beats, dash: 0, ease: "decelerate" }], close) });
    const fade = (name: string, pairs: Array<[number, number]>, first = 0): Track => ({
      select: select(name), keys: looped([{ at: 0, o: first }, ...pairs.flatMap(([at, o]): Key[] => [{ at, o: 1 - o }, { at: at + 0.5, o, ease: "standard" }])], close),
    });
    // Title: the o's circle strokes on over its keyline square, which then fades.
    const title: Track[] = [draw(select("to-c"), 100, 1, 1.6), fade("to-k", [[2.2, 1], [5, 0]])];
    const glyph: Track[] = [
      draw(select("kl-grid"), GRID_LENGTH, AT.grid, 1.8), draw(select("kl-pad"), 80, AT.grid + 1, 1), draw(select("kl-circle"), 63, AT.grid + 1.4, 1.1),
      ...Array.from({ length: GLYPH_PATHS }, (_, n) => draw(`${select("kl-glyph")} path:nth-of-type(${n + 1})`, GLYPH_DASH, AT.strokes + n * 0.5, 1.2)),
      ...reveal("kl-n0", AT.grid + 0.6, copy.grid, close), ...reveal("kl-n1", AT.grid + 1.4, copy.padding, close), ...reveal("kl-n2", AT.strokes + 0.6, copy.stroke, close),
    ];
    // Grows with text: each step crossfades the icon and the word together; the readouts roll with them.
    const starts = STEPS.map((_, k) => (k === 0 ? 0 : AT.steps + (k - 1) * STEP));
    const grow: Track[] = STEPS.flatMap((_, k): Track[] => {
      const on = starts[k]!;
      const off = starts[k + 1];
      const pairs: Array<[number, number]> = [...(k > 0 ? [[on - 0.5, 1] as [number, number]] : []), ...(off ? [[off - 0.5, 0] as [number, number]] : [])];
      return [fade(`gi-${k}`, pairs, k === 0 ? 1 : 0), fade(`gt-${k}`, pairs, k === 0 ? 1 : 0)];
    });
    const times = starts.map((at, k) => [at, k] as [number, number]);
    grow.push(
      ...rollerTracks("grr", STEPS.map((step) => step.role), STEPS.length - 1, times, g.lines.grr ?? 0, close, 0.5),
      ...rollerTracks("grn", STEPS.map((step) => step.icon), STEPS.length - 1, times, g.lines.grn ?? 0, close, 0.5),
      ...rollerTracks("grp", STEPS.map((step) => String(step.px)), STEPS.length - 1, times, g.lines.grp ?? 0, close, 0.5),
    );
    // In place: icons pop in (0.85 → 1) row by row, then the toolbar; the column's size shows once on the right.
    const pop = (name: string, at: number): Track => ({ select: select(name), keys: looped([{ at: 0, s: 0.85, o: 0 }, { at, s: 0.85, o: 0 }, { at: at + 0.5, s: 1, o: 1, ease: "emphasized" }], close) });
    const marks = g.scopes.pl ?? {};
    const point = (k: number): Pose => {
      const box = marks[`r${k}`]?.box ?? { x: 0, y: 0, w: 100, h: 30 };
      return { x: box.x + box.w * 0.62, y: box.y + box.h * 0.5 };
    };
    const below = point(3);
    const place: Track[] = [
      ...[0, 1, 2, 3].map((k) => pop(`pl-i${k}`, AT.pops + k * 0.35)), ...[0, 1, 2, 3].map((k) => pop(`pl-tb${k}`, AT.tools + k * 0.2)),
      fade("pl-tag", [[AT.tag, 1]]),
      // Tone: all muted; the hovered row goes primary, the clicked one accent.
      fade("pl-t1-primary", [[AT.h1, 1], [AT.h2, 0]]), fade("pl-hv1", [[AT.h1, 1], [AT.h2, 0]]),
      fade("pl-t2-primary", [[AT.h2, 1], [AT.click, 0]]), fade("pl-t2-accent", [[AT.click, 1]]), fade("pl-hv2", [[AT.h2, 1]]),
      fade("pl-t2-muted", [[AT.h2, 0]], 1), fade("pl-t1-muted", [[AT.h1, 0], [AT.h2, 1]], 1),
      { select: select("pl-cur"), keys: looped([
        { at: 0, x: below.x ?? 0, y: (below.y ?? 0) + 40, o: 0, s: 1 }, { at: AT.enter, o: 0 }, { at: AT.enter + 0.3, o: 1 },
        { at: AT.h1, ...point(1), ease: "standard" }, { at: AT.h2 - 0.6, ...point(1) }, { at: AT.h2, ...point(2), ease: "standard" },
        { at: AT.click, s: 1 }, { at: AT.click + 0.15, s: 0.8 }, { at: AT.click + 0.4, s: 1 },
      ], close) },
    ];
    return { tracks: [...introTracks(copy.title, copy.lead, close), ...title, ...glyph, ...grow, ...place], camera };
  };
}

export const ICON_END = AT.end;
