import { fit, focus, type Key, type Pose, type Track } from "../../heroTimeline";
import { motionDistance } from "../../../../lib/motion";
import { CANVAS, GRID } from "../shared/grid";
import { reveal, select } from "../shared/Reveal";
import type { SceneContext } from "../scene/types";
import { EASES, GHOSTS, type MotionCopy } from "./motionCopy";
import { arrive, fillNote, looped, shown } from "./motionKeys";
import { TICKS, TRACK } from "./motionLanes";
import { AT, RUN } from "./motionScore";
import { scoreTracks, twinTracks } from "./motionTurnTracks";
import { exitTimes } from "./MotionStages";

/** Canvas px kept clear along the bottom edge for the metronome (and, wide, the frame's crop). */
const BAND = { wide: 92, tall: 48 } as const;
/** How far a scene sits above the canvas centre: half the metronome's own height (the wide crop is symmetric). */
const LIFT = { wide: 28, tall: 18 } as const;

/** The title lands one letter per tick; the lead lines start on the next ticks; all leave on beat 8, faster than they came. */
function introTracks(copy: MotionCopy, close: number): Track[] {
  const leave = (name: string, at: number): Track => ({
    select: select(name), keys: looped([{ at: 0, y: 0, o: 1 }, { at, y: 0, o: 1 }, { at: at + 0.7, y: -56, o: 0, ease: "accelerate" }], close),
  });
  const rise = motionDistance("lg") || 24;
  return [
    ...[...copy.title].map((_, k) => arrive(`ml-${k}`, k, 1, { y: rise }, close)),
    ...copy.lead.flatMap(([key, text], n) => [...reveal(`i-k${n}`, 2 + n, key, close), ...reveal(`i-l${n}`, 2.5 + n, text, close)]),
    leave("i-title", AT.lanes), ...copy.lead.map((_, n) => leave(`i-p${n}`, AT.lanes + 0.5 * (n + 1))),
  ];
}

/** The metronome's cursor steps onto the next tick on every beat (landing in a quarter beat), from the top each cycle. */
function metronome(beats: number, close: number, layout: "wide" | "tall"): Track {
  const step = (CANVAS[layout].w - GRID[layout].margin * 2 - 1) / (TICKS - 1);
  const x = (beat: number) => (beat % TICKS) * step;
  const keys: Key[] = [{ at: 0, x: 0 }];
  for (let beat = 1; beat < beats - 0.3; beat += 1) {
    if (beat % TICKS === 0) keys.push({ at: beat - 0.01, x: x(beat - 1) }, { at: beat, x: 0 });
    else keys.push({ at: beat, x: x(beat - 1) }, { at: beat + 0.25, x: x(beat), ease: "decelerate" });
  }
  keys.push({ at: close - 0.01 }, { at: close, x: 0 });
  return { select: select("metro"), keys };
}

/** Two runs of the five pucks; the ghosts appear with the first and stay. */
function laneTracks(layout: "wide" | "tall", close: number): Track[] {
  const track = TRACK[layout];
  const [one, two] = AT.run;
  return EASES.flatMap((ease): Track[] => [
    { select: select(`lp-${ease}`), keys: looped([{ at: 0, x: 0 }, { at: one, x: 0 }, { at: one + RUN, x: track, ease }, { at: two - 0.26, x: track }, { at: two - 0.25, x: 0 }, { at: two, x: 0 }, { at: two + RUN, x: track, ease }], close) },
    ...Array.from({ length: GHOSTS }, (_, k) => arrive(`lg-${ease}-${k}`, one + (k / (GHOSTS - 1)) * RUN, 0.15, {}, close, "linear")),
  ]);
}

/** In fast, out faster: two plays at half speed, one at real speed; each note fills while its move plays. */
function exitTracks(close: number): Track[] {
  const { enter, exit } = exitTimes();
  const speed = (p: number) => (p < 2 ? 160 : 320);
  const rise = motionDistance("sm") || 4;
  const menu: Key[] = [{ at: 0, o: 0, s: 0.97, y: rise }];
  const inPlays: Array<[number, number]> = [];
  const outPlays: Array<[number, number]> = [];
  AT.plays.forEach(([a, b], p) => {
    const [e, x] = [enter / speed(p), exit / speed(p)];
    menu.push({ at: a, o: 0, s: 0.97, y: rise }, { at: a + e, o: 1, s: 1, y: 0, ease: "standard" }, { at: b, o: 1, s: 1, y: 0 }, { at: b + x, o: 0, s: 0.97, y: 0, ease: "accelerate" });
    inPlays.push([a, e]);
    outPlays.push([b, x]);
  });
  const realAt = AT.plays[2]![0] - 0.5;
  return [
    { select: select("ex-menu"), keys: looped(menu, close) },
    ...fillNote("exb-in", inPlays, close), ...fillNote("exb-out", outPlays, close),
    { select: select("ex-half"), keys: looped([{ at: 0, o: 1 }, { at: realAt, o: 1 }, { at: realAt + 0.2, o: 0 }], close) },
    shown("ex-real", realAt, null, close),
  ];
}

/** The Switch toggles on three ticks; its thumb springs over --motion-base (one beat) each time. */
function springTracks(close: number): Track[] {
  const [on, off, again] = AT.toggles;
  const fade = 0.2;
  const layer = (first: number): Key[] => [{ at: 0, o: first }];
  const onKeys = layer(0);
  const offKeys = layer(1);
  for (const [at, to] of [[on, 1], [off, 0], [again, 1]] as const) {
    onKeys.push({ at, o: 1 - to }, { at: at + fade, o: to });
    offKeys.push({ at, o: to }, { at: at + fade, o: 1 - to });
  }
  const thumb = (name: string, keys: Key[]): Track => ({ select: `${select(name)} [data-slot="switch-thumb"]`, keys: looped(keys, close) });
  return [
    { select: select("sp-on"), keys: looped(onKeys, close) }, { select: select("sp-off"), keys: looped(offKeys, close) },
    thumb("sp-on", [{ at: 0, x: 0 }, { at: on, x: 0 }, { at: on + 1, x: 14, ease: "spring" }, { at: again - 0.01, x: 14 }, { at: again, x: 0 }, { at: again + 1, x: 14, ease: "spring" }]),
    thumb("sp-off", [{ at: 0, x: 0 }, { at: off - 0.01, x: 0 }, { at: off, x: 14 }, { at: off + 1, x: 0, ease: "spring" }]),
  ];
}

export function motionTracks(copy: MotionCopy) {
  return ({ g, cells, close, beats }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const canvas = g.canvas;
    const band = BAND[g.layout];
    // A scene's frame: on its cell's centre line (one-axis moves), zoomed to fit `box` above the metronome's band.
    const frame = (cell: string, cap = 2, y = cells[cell]!.y, box = g.boxes[cell]!): Pose => {
      const zoom = fit({ w: canvas.w, h: canvas.h - band }, box, 0.9, cap);
      const pose = focus(canvas, { x: cells[cell]!.x - 1, y: y - 1, w: 2, h: 2 }, zoom);
      return { ...pose, y: (pose.y ?? 0) - LIFT[g.layout] };
    };
    // Tall: Reduced stands under Full (below the cell), so the camera steps down to it before it plays.
    const tall = g.layout === "tall";
    const reduced = tall ? g.boxes.twr : undefined;
    const moves: Array<[number, Pose]> = [
      [AT.lanes, frame("lanes")], [AT.exits, frame("exits")], [AT.score, frame("score")], [AT.twins, tall ? frame("twins", 2, g.boxes.twf!.y + g.boxes.twf!.h / 2, g.boxes.twf) : frame("twins")],
      ...(reduced ? [[AT.reduced - 4, frame("twins", 2, reduced.y + reduced.h / 2, reduced)] as [number, Pose]] : []),
      [AT.spring, frame("spring", 1.4)],
    ];
    const front = focus(canvas, { x: cells.intro!.x - 1, y: cells.intro!.y - 1, w: 2, h: 2 }, 1);
    const camera: Key[] = [{ at: 0, ...front }, ...moves.flatMap(([at, pose], k): Key[] => [
      { at, ...(k === 0 ? front : moves[k - 1]![1]) }, { at: at + 4, ...pose, ease: "standard" },
    ]), { at: AT.end, ...moves.at(-1)![1] }];
    const tracks: Track[] = [
      ...introTracks(copy, close), ...laneTracks(g.layout, close), ...exitTracks(close),
      ...scoreTracks(g, close), ...twinTracks(g, close), ...springTracks(close), metronome(beats, close, g.layout),
    ];
    return { tracks, camera };
  };
}

export const MOTION_END = AT.end;
