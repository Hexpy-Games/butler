import type { Key, Track } from "../../heroTimeline";
import type { SceneGeometry } from "../scene/types";
import { SETTLE, TRANSITION } from "../shared/beats";
import { REST } from "../shared/scene";
import { gridDiagonals } from "./iconGrid";
import { STROKES } from "./iconParts";

/**
 * 06 Iconography: the beat marks every scene keys on, and the finale (the
 * icon grid drawing while the camera pulls out). See iconTracks.ts.
 */
export const AT = {
  titleKey: 0.4, titleO: 1, titleKeyOut: 4.2,
  glyph: 6.8, grid: 7.8, pad: 8.8, circle: 9.2, n0: 8.4, n1: 9.6, strokes: 10.8, n2: 12,
  grow: 15, steps: 20.2,
  place: 29.2, pops: 30.8, tag: 32.8, enter: 33.6, arrive: 34.6, click: 35.4,
  finale: 37.2,
} as const;
/** The grid's draw: beats between diagonals, and one glyph's stroke-on. */
const DIAGONAL = 0.4;
const DRAW = 1.2;
/** The close-up on the gear (camera zoom) and its hold before the pull-out. */
export const CLOSE = 4;
const LAND = 0.2;
/** Diagonals past the gear's own that are drawing as the camera lands. */
const AHEAD = 1;
/** The sidebar's fade as the finale starts; the gear then shows in its place. */
export const LEAVE = 0.8;

export const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

/**
 * The finale's beats: diagonal `d` starts drawing at `wave(d)`, so the ring
 * round the gear is drawing as the camera lands on it (the diagonals before
 * draw while it zooms in); the pull-out runs from the landing to the moment
 * the last, bottom-right diagonal finishes; then the hold and the loop.
 */
export function finaleBeats(layout: SceneGeometry["layout"]) {
  const { centre, last } = gridDiagonals(layout);
  const arrive = AT.finale + TRANSITION;
  // Diagonals due before the sidebar has gone start as it goes (they are off the frame until the pull-out).
  const wave = (d: number) => Math.max(AT.finale + LEAVE, arrive + (d - centre - AHEAD) * DIAGONAL);
  const start = arrive + LAND;
  const end = wave(last) + DRAW;
  const loop = end + SETTLE;
  // The grid fades (half a transition), then the cycle cuts straight back to the title: no blank beat.
  const restart = loop + TRANSITION / 2 + 0.2;
  return { wave, start, end, loop, restart, beats: restart + 0.1, centre, last };
}

export type FinaleBeats = ReturnType<typeof finaleBeats>;

/** A stroke drawing along its length from `at` over `dur` beats (reset for the next cycle at `close`). */
export function drawTrack(select: string, len: number, at: number, dur: number, close: number): Track {
  return { select, keys: looped([{ at: 0, dash: len }, { at, dash: len }, { at: at + dur, dash: 0, ease: "decelerate" }], close) };
}

/** The pull-out: the frame's reach (1 / zoom) widens on a smooth curve from the close-up to the whole grid, about the frame's centre. */
export function pullKeys(f: FinaleBeats): Key[] {
  const keys: Key[] = [];
  for (let at = f.start; at < f.end + 0.001; at += 0.2) {
    const u = Math.min(1, (at - f.start) / (f.end - f.start));
    const ease = u * u * (3 - 2 * u);
    const reach = 1 / CLOSE + (1 - 1 / CLOSE) * ease;
    keys.push({ at: Math.min(at, f.end), ...REST, s: 1 / reach, ease: "linear" });
  }
  return keys;
}

/** The grid: the gear (centre) shows as the sidebar goes; the rest draws one diagonal at a time from the top-left. */
export function gridTracks(f: FinaleBeats, close: number): Track[] {
  const gear: Track = { select: '[data-t="grid"] [data-centre]', keys: looped([{ at: 0, o: 0 }, { at: AT.finale + LEAVE - 0.2, o: 0 }, { at: AT.finale + LEAVE + 0.3, o: 1, ease: "standard" }], close) };
  return [gear, ...Array.from({ length: f.last + 1 }, (_, d): Track[] => {
    const at = f.wave(d);
    const cell = `[data-t="grid"] [data-d="${d}"]`;
    return [
      { select: cell, keys: looped([{ at: 0, o: 0 }, { at: at - 0.01, o: 0 }, { at, o: 1 }], close) },
      drawTrack(`${cell} ${STROKES}`, 100, at, DRAW, close),
    ];
  }).flat()];
}
