import type { Key, Pose, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { select } from "../shared/Reveal";
import type { SceneContext } from "../scene/types";
import { EASES, GHOSTS, ms, type MotionCopy } from "./motionCopy";
import { TRACK } from "./motionLanes";
import { SCORE, SCORE_SPAN } from "./MotionScenes";

/**
 * 08 Motion, "the score", beat marks (1 beat = --motion-deliberate; a
 * metronome ticks it along the bottom edge all chapter long):
 *
 *   0–7.4     Title      "Motion" enters one letter per tick
 *   6.8–18.6  Lanes      five pucks race the same distance in the same time,
 *                        ghost frames every tenth showing each curve's spacing
 *   18.6–33   Exits      the menu enters over its note bar, then exits on a
 *                        shorter one; twice slowed, once at real speed
 *   33–51.5   Score      a real conversation turn plays over its piano roll
 *   51.5–67   Twins      Full, then Reduced: the same turn, the idle twin dimmed
 *   67–76     Spring     the Switch thumb springs; a dragged card lifts
 */
const AT = { lanes: 6.8, run: 11.4, exits: 18.6, plays: [23, 27.6, 31.6], score: 33, s: 37.6, twins: 51.5, full: 56, reduced: 61.5, spring: 67, toggle: 71.6, lift: 73.6, end: 76 } as const;
/** One run of the lanes (slowed ×3, like reading a curve at a third of its speed). */
const RUN = 2.4;
const beats = (time: number) => time / 320;

const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

/** A part hidden until `at`, then arriving from `from` over `length` beats, held to the close. */
function arrive(name: string, at: number, length: number, from: Pose, close: number, ease: Key["ease"] = "decelerate"): Track {
  const rest = Object.fromEntries(Object.keys(from).map((field) => [field, field === "s" ? 1 : 0])) as Pose;
  return { select: select(name), keys: looped([{ at: 0, ...from, o: 0 }, { at, ...from, o: 0 }, { at: at + length, ...rest, o: 1, ease }], close) };
}

export function motionTracks(copy: MotionCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const cells = ["lanes", "exits", "score", "twins", "spring"] as const;
    const starts = [AT.lanes, AT.exits, AT.score, AT.twins, AT.spring];
    const poses = cells.map((cell) => view(cell, g.boxes[cell]!, 0.9, 2));
    const front = view("intro", g.boxes.intro!, 1, 1);
    const camera: Key[] = [{ at: 0, ...front }, ...cells.flatMap((_, k): Key[] => [
      { at: starts[k]!, ...(k === 0 ? front : poses[k - 1]!) }, { at: starts[k]! + TRANSITION, ...poses[k]!, ease: "standard" },
    ]), { at: AT.end, ...poses.at(-1)! }];
    const track = TRACK[g.layout];
    const run2 = AT.run + RUN + 1.4;
    const tracks: Track[] = [
      ...introTracks(copy.title, copy.lead, close),
      ...[...copy.title].map((_, k) => arrive(`ml-${k}`, 0.4 + k, 0.8, { y: 24 }, close)),
      // The lanes: two runs; the ghosts stay after the first.
      ...EASES.flatMap((ease): Track[] => [
        { select: select(`lp-${ease}`), keys: looped([{ at: 0, x: 0 }, { at: AT.run, x: 0 }, { at: AT.run + RUN, x: track, ease }, { at: run2 - 0.01, x: track }, { at: run2, x: 0 }, { at: run2 + RUN, x: track, ease }], close) },
        ...Array.from({ length: GHOSTS }, (_, k) => arrive(`lg-${ease}-${k}`, AT.run + (k / (GHOSTS - 1)) * RUN, 0.2, {}, close, "linear")),
      ]),
      ...exitTracks(close),
      ...scoreTracks(close),
      // Twins: Full plays with the reduced side dimmed, then Reduced with the full side dimmed.
      { select: select("tw-r"), keys: looped([{ at: 0, o: 1 }, { at: AT.full - 0.4, o: 1 }, { at: AT.full, o: 0.4 }, { at: AT.reduced - 0.4, o: 0.4 }, { at: AT.reduced, o: 1 }], close) },
      { select: select("tw-f"), keys: looped([{ at: 0, o: 1 }, { at: AT.reduced - 0.4, o: 1 }, { at: AT.reduced, o: 0.4 }, { at: AT.spring, o: 0.4 }, { at: AT.spring + 1, o: 1 }], close) },
      arrive("tw-f-b", AT.full, 2, { y: 40 }, close, "standard"), arrive("tw-f-r", AT.full + 2.2, 1.5, { y: 8 }, close),
      arrive("tw-r-b", AT.reduced, 2, {}, close, "standard"), arrive("tw-r-r", AT.reduced + 2.2, 1.5, {}, close),
      // Spring: the thumb overshoots and settles; the dragged card lifts.
      { select: select("sp-off"), keys: looped([{ at: 0, o: 1 }, { at: AT.toggle, o: 1 }, { at: AT.toggle + 0.2, o: 0 }], close) },
      { select: select("sp-on"), keys: looped([{ at: 0, o: 0 }, { at: AT.toggle, o: 0 }, { at: AT.toggle + 0.2, o: 1 }], close) },
      { select: `${select("sp-on")} [data-slot="switch-thumb"]`, keys: looped([{ at: 0, x: 0 }, { at: AT.toggle, x: 0 }, { at: AT.toggle + 1.2, x: 14, ease: "spring" }], close) },
      { select: select("sp-card"), keys: looped([{ at: 0, s: 1 }, { at: AT.lift, s: 1 }, { at: AT.lift + 0.8, s: 1.02, ease: "standard" }], close) },
    ];
    return { tracks, camera };
  };
}

/** In fast, out faster: each play enters the top menu, then exits the bottom one; bars light as they play. */
function exitTracks(close: number): Track[] {
  const [enter, exit] = [beats(ms("--motion-enter-menu", 140)), beats(ms("exit-menu"))];
  const slow = [6, 6, 1];
  const inKeys: Key[] = [{ at: 0, s: 0.97, o: 0 }];
  const outKeys: Key[] = [{ at: 0, s: 1, o: 1 }];
  const light = (at: number, length: number): Key[] => [{ at: at - 0.01, o: 0.3 }, { at, o: 1 }, { at: at + length + 0.6, o: 1 }, { at: at + length + 1, o: 0.3 }];
  const inBar: Key[] = [{ at: 0, o: 0.3 }];
  const outBar: Key[] = [{ at: 0, o: 0.3 }];
  AT.plays.forEach((at, p) => {
    const [e, x] = [enter * slow[p]!, exit * slow[p]!];
    inKeys.push({ at: at - 0.3, s: 0.97, o: 0 }, { at, s: 0.97, o: 0 }, { at: at + e, s: 1, o: 1, ease: "standard" });
    outKeys.push({ at: at - 0.3, s: 1, o: 1 }, { at: at + e + 0.4, s: 1, o: 1 }, { at: at + e + 0.4 + x, s: 0.97, o: 0, ease: "accelerate" });
    inBar.push(...light(at, e));
    outBar.push(...light(at + e + 0.4, x));
  });
  return [
    { select: select("ex-in"), keys: looped(inKeys, close) }, { select: select("ex-out"), keys: looped(outKeys, close) },
    { select: select("exb-in"), keys: looped(inBar, close) }, { select: select("exb-out"), keys: looped(outBar, close) },
    arrive("ex-real", AT.plays[2]! - 0.8, 0.5, {}, close),
  ];
}

/** The score: the turn's events in order, each bar lighting as the playhead reaches it. */
function scoreTracks(close: number): Track[] {
  const S = AT.s;
  const pulses: Key[] = [{ at: 0, s: 1, o: 0 }, { at: S + 3.7, s: 1, o: 0 }, { at: S + 3.8, o: 1 }];
  for (let k = 0; k < 4; k += 1) pulses.push({ at: S + 3.7 + k * 0.6 + 0.3, s: 1.15, ease: "standard" }, { at: S + 3.7 + k * 0.6 + 0.6, s: 1, ease: "standard" });
  pulses.push({ at: S + 6.1, o: 1 }, { at: S + 6.4, o: 0 });
  return [
    { select: select("sc-send"), keys: looped([{ at: 0, s: 1 }, { at: S + 1, s: 1 }, { at: S + 1.25, s: 0.97, ease: "standard" }, { at: S + 1.5, s: 1, ease: "standard" }], close) },
    arrive("sc-bubble", S + 1.5, 2, { y: 150 }, close, "standard"),
    { select: select("sc-think"), keys: looped(pulses, close) },
    arrive("sc-reply", S + 6.3, 1.5, { y: 8 }, close),
    arrive("sc-check", S + 8, 0.8, { s: 0.85 }, close, "spring"),
    { select: select("sc-notice"), keys: looped([{ at: 0, y: 24, o: 0 }, { at: S + 9, y: 24, o: 0 }, { at: S + 10.2, y: 0, o: 1, ease: "decelerate" }, { at: S + 11.2, o: 1 }, { at: S + 11.8, o: 0, ease: "accelerate" }], close) },
    { select: select("sc-play"), keys: looped([{ at: 0, xp: 0, o: 0 }, { at: S, xp: 0, o: 1 }, { at: S + SCORE_SPAN, xp: 100, ease: "linear" }], close) },
    ...SCORE.map(([, start], j): Track => ({ select: select(`sb-${j}`), keys: looped([{ at: 0, o: 0.25 }, { at: S + start - 0.01, o: 0.25 }, { at: S + start + 0.2, o: 1 }], close) })),
  ];
}

export const MOTION_END = AT.end;
