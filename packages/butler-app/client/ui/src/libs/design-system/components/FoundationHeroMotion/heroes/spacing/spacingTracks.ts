import type { Key, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, revealBeats, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { SceneContext } from "../scene/types";
import { COMPACT_PAD, GAPS, STEPS, type GapId, type SpacingCopy } from "./spacingCopy";
import { RHYTHM } from "./SpacingScenes";
import { count, sum } from "./spacingTiles";

/**
 * 03 Spacing, "counted space", beat marks (1 beat = --motion-deliberate):
 *
 *   0–7.4     Title    the letters drift apart, a 4px block in each gap, and back
 *   6.8–21.2  Unit     one 4px unit, drawn large and named "the base unit";
 *                      it shrinks into the xs slot and the named steps build
 *                      from it, each with its size; the readout counts px = n×4
 *   21.2–36.6 Count    a real settings section: each space in turn is
 *                      highlighted, a column of units stacks beside it (as
 *                      tall as the space) and its count and token are named
 *   36.6–51   Rhythm   the page: 3 units in a group, 5 between rows, 10
 *                      between sections; the highlights pulse small to large
 *   51–61.4   Density  comfortable beside compact: the inset is 6 units, 4
 */
const AT = {
  spread: 2.6, gather: 5, stairs: 6.8, unit: 8.4, name: 9.6, shrink: 13.6, land: 14.8,
  count: 21.2, rhythm: 36.6, pulse: 47, density: 51, end: 61.4,
} as const;
/** How far the title's letters drift apart (canvas px, the block in each gap). */
const DRIFT = 12;
/** The unit drawn large: its scale over one staircase block, and how far above the cell's middle it sits (canvas px, room for its name below). */
const BIG = { wide: 7, tall: 8 } as const;
const LIFT = 28;
/** One unit stacking onto its column. */
const UNIT_STEP = 0.12;
/** The order the section's spaces are counted, and the beats between them. */
const ORDER: GapId[] = ["hg", "pt", "fg", "pb"];
const PER_GAP = 2.2;

const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

/** Shows at `from` (a short fade) and holds through the cycle. */
const shown = (name: string, from: number, close: number, o = 1): Track => ({
  select: select(name), keys: looped([{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.4, o, ease: "decelerate" }], close),
});

/**
 * One measured space: the highlight fades in, its units stack bottom up, then
 * its label reads left to right. Returns the tracks and when the label is read.
 */
function measure(name: string, n: number, label: string | null, at: number, close: number): { tracks: Track[]; done: number } {
  const units = Array.from({ length: n }, (_, j) => shown(`${name}-u${j}`, at + 0.4 + j * UNIT_STEP, close));
  const read = at + 0.5 + n * UNIT_STEP;
  const tracks = [shown(`${name}-f`, at, close), ...units, ...(label === null ? [] : reveal(`${name}-l`, read, label, close))];
  return { tracks, done: read + (label === null ? 0 : revealBeats([...label].length)) };
}

export function spacingTracks(copy: SpacingCopy) {
  return ({ g, cells, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { layout } = g;
    const tall = layout === "tall";
    const poses = {
      intro: view("intro", g.boxes.intro!, 1, 1), stairs: view("stairs", g.boxes.stairs!, 0.86, 1.8),
      ex: view("ex", g.boxes.ex!, 0.92, tall ? 1.8 : 2), rh: view("rh", g.boxes.rh!, 0.9, 1.8), dn: view("dn", g.boxes.dn!, 0.92, 1.8),
    };
    const camera: Key[] = [
      { at: 0, ...poses.intro }, { at: AT.stairs, ...poses.intro }, { at: AT.stairs + TRANSITION, ...poses.stairs, ease: "standard" },
      { at: AT.count, ...poses.stairs }, { at: AT.count + TRANSITION, ...poses.ex, ease: "standard" },
      { at: AT.rhythm, ...poses.ex }, { at: AT.rhythm + TRANSITION, ...poses.rh, ease: "standard" },
      { at: AT.density, ...poses.rh }, { at: AT.density + TRANSITION, ...poses.dn, ease: "standard" }, { at: AT.end, ...poses.dn },
    ];
    // Title: letters show one by one, drift apart with a block in each gap, and close again.
    const letters = [...copy.title];
    const title: Track[] = letters.flatMap((_, k): Track[] => [
      { select: select(`tl-${k}`), keys: looped([{ at: 0, o: 0, x: 0 }, { at: 0.4 + k * 0.1, o: 0 }, { at: 0.8 + k * 0.1, o: 1 }, { at: AT.spread, x: 0 }, { at: AT.spread + 1.2, x: k * DRIFT, ease: "emphasized" }, { at: AT.gather, x: k * DRIFT }, { at: AT.gather + 1, x: 0, ease: "standard" }], close) },
      ...(k < letters.length - 1 ? [{ select: select(`tb-${k}`), keys: looped([{ at: 0, o: 0, s: 0.4 }, { at: AT.spread + 0.4 + k * 0.08, o: 0, s: 0.4 }, { at: AT.spread + 1 + k * 0.08, o: 1, s: 1, ease: "decelerate" }, { at: AT.gather, o: 1, s: 1 }, { at: AT.gather + 0.6, o: 0, s: 0.4, ease: "accelerate" }], close) }] : []),
    ]);
    // The unit: large and named in the middle of the frame; it shrinks into the xs slot, where xs takes over; the steps build from it.
    const unit = g.boxes.unit ?? { x: 0, y: 0, w: 24, h: 24 };
    const middle = cells.stairs ?? { x: unit.x, y: unit.y };
    const big = { x: middle.x - (unit.x + unit.w / 2), y: middle.y - LIFT - (unit.y + unit.h / 2), s: BIG[layout] };
    const grows = STEPS.map((_, k) => (k === 0 ? AT.land : AT.land + 0.6 + (k - 1) * 0.55));
    const times = grows.map((at, k) => [at, k] as [number, number]);
    const last = STEPS.length - 1;
    const stairs: Track[] = [
      { select: select("unit"), keys: looped([{ at: 0, ...big, o: 0 }, { at: AT.unit, o: 0 }, { at: AT.unit + 0.6, o: 1, ease: "decelerate" }, { at: AT.shrink, ...big }, { at: AT.land, x: 0, y: 0, s: 1, ease: "standard" }, { at: AT.land + 0.2, o: 1 }, { at: AT.land + 0.21, o: 0 }], close) },
      { select: select("unit-l"), keys: looped([{ at: 0, o: 1 }, { at: AT.shrink, o: 1 }, { at: AT.shrink + 0.5, o: 0, ease: "accelerate" }, { at: close - 0.4, o: 0 }, { at: close - 0.39, o: 1 }], close) },
      ...reveal("unit-t", AT.name, copy.unit, close), ...reveal("unit-k", AT.name + 1, "--space-xs", close),
      ...grows.flatMap((at, k): Track[] => [
        { select: select(`st-${k}`), keys: looped(k === 0 ? [{ at: 0, o: 0 }, { at: at + 0.19, o: 0 }, { at: at + 0.2, o: 1 }] : [{ at: 0, o: 0, ...(tall ? { sx: 0 } : { sy: 0 }) }, { at: at - 0.01, o: 0 }, { at, o: 1 }, { at: at + 0.6, ...(tall ? { sx: 1 } : { sy: 1 }), ease: "decelerate" }], close) },
        shown(`st-n${k}`, at + 0.1, close),
      ]),
      shown("st-read", AT.land, close),
      ...STEPS.map((_, k): Track => ({ select: select(`sts-${k}`), keys: looped([{ at: 0, o: k === 0 ? 1 : 0 }, ...grows.slice(1).flatMap((at, j): Key[] => [{ at: at - 0.01, o: j === k - 1 ? 1 : 0 }, { at, o: j + 1 === k ? 1 : 0 }])], close) })),
      ...rollerTracks("stp", STEPS.map(([, px]) => String(px)), last, times, g.lines.stp ?? 0, close, 0.4),
      ...rollerTracks("stn", STEPS.map(([, px]) => String(count(px))), last, times, g.lines.stn ?? 0, close, 0.4),
    ];
    // Count: each space of the section in turn.
    const counted: Track[] = ORDER.flatMap((id, k) => measure(`ex-${id}`, count(GAPS[id].px), `${sum(GAPS[id].px)} · ${GAPS[id].token}`, AT.count + TRANSITION + 0.2 + k * PER_GAP, close).tracks);
    // Rhythm: the three measures show in turn, then their highlights pulse small, medium, large, twice.
    const notes = [copy.inGroup, copy.betweenRows, copy.betweenSections];
    const rhythm: Track[] = RHYTHM.flatMap((id, k) => {
      const { tracks } = measure(`rh-${k}`, count(GAPS[id].px), `${sum(GAPS[id].px)} · ${notes[k]}`, AT.rhythm + TRANSITION + 0.2 + k * 1.4, close);
      const beats = [AT.pulse + k * 0.6, AT.pulse + 1.8 + k * 0.6];
      const fill: Track = {
        select: select(`rh-${k}-f`),
        keys: looped([{ at: 0, o: 0 }, { at: AT.rhythm + TRANSITION + 0.2 + k * 1.4, o: 0 }, { at: AT.rhythm + TRANSITION + 0.6 + k * 1.4, o: 1, ease: "decelerate" }, ...beats.flatMap((b): Key[] => [{ at: b, o: 1 }, { at: b + 0.2, o: 0.35, ease: "accelerate" }, { at: b + 0.6, o: 1, ease: "decelerate" }])], close),
      };
      return [...tracks.filter((track) => track.select !== select(`rh-${k}-f`)), fill];
    });
    // Density: both copies show their spaces; the insets are counted side by side, 6 units against 4.
    const show = AT.density + TRANSITION + 0.2;
    const density: Track[] = (["dc", "dk"] as const).flatMap((name, c) => {
      const inset = c === 0 ? GAPS.pt.px : COMPACT_PAD;
      return [
        ...reveal(`${name}-h`, show + c * 0.3, c === 0 ? copy.comfortable : copy.compact, close),
        ...reveal(`${name}-k`, show + 0.4 + c * 0.3, `${GAPS.pt.token} ${inset}`, close),
        ...(["hg", "fg"] as GapId[]).map((id) => shown(`${name}-${id}-f`, show + 0.8, close)),
        ...(["pt", "pb"] as GapId[]).flatMap((id, j) => measure(`${name}-${id}`, count(inset), sum(inset), show + 1.2 + j * 0.9, close).tracks),
      ];
    });
    const tracks: Track[] = [...introTracks(copy.title, copy.lead, close), ...title, ...stairs, ...counted, ...rhythm, ...density];
    return { tracks, camera };
  };
}

export const SPACING_END = AT.end;
