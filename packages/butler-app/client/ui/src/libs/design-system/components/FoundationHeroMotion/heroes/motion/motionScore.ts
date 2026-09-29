import { motionDuration, type MotionDurationName } from "../../../../lib/motion";

/**
 * 08 Motion's clock. One beat is --motion-deliberate (320 ms) and the
 * metronome ticks it along the frame's bottom edge all chapter long. Every
 * move starts on a tick (or the half between two); its length is the real
 * token, played at half speed so a beat holds --motion-base (160 ms).
 *
 *   0–8     Title    "Motion" lands one letter per tick (1…6)
 *   8–24    Lanes    two runs of the five curves, ghosts every tenth
 *   24–38   Exits    the composer's + menu enters, then exits faster
 *   38–60   Score    a real turn: Send, flight, thinking, reply, done
 *   60–82   Twins    Full, then Reduced two bars later, the idle twin dimmed
 *   82–94   Spring   the Switch thumb springs, three toggles
 */
export const AT = {
  lanes: 8, run: [13, 17], exits: 24, plays: [[29, 30], [31, 32], [34, 35]] as Array<[number, number]>,
  score: 38, s: 42, twins: 60, full: 65, reduced: 73, twinsRest: 79, spring: 82, toggles: [87, 89, 91], end: 94,
} as const;

/** UI milliseconds per beat in the scenes (half speed: one beat holds --motion-base). */
export const BEAT_MS = 160;

/** One lane run of the onion-skin scene, in beats. */
export const RUN = 3;

/** A token's length in beats at the scenes' tempo. */
export const beatsOf = (name: MotionDurationName) => motionDuration(name) / BEAT_MS;

/** Beats a piano roll spans (four bars of four). */
export const SCORE_SPAN = 16;
export const TWIN_SPAN = 4;

export interface Note {
  lane: number;
  /** Beat from the roll's start. */
  at: number;
  len: number;
  /** A loop (the thinking mark) is drawn as repeated short notes. */
  loop?: boolean;
  /** Opacity only (the reduced twin): a thin note. */
  flat?: boolean;
}

/** The turn's events, beats from the score's start. */
export function scoreNotes(): Note[] {
  return [
    { lane: 0, at: 1, len: beatsOf("instant") },
    { lane: 1, at: 2, len: beatsOf("slow") },
    { lane: 2, at: 4, len: 8, loop: true },
    { lane: 3, at: 12, len: beatsOf("base") },
    { lane: 4, at: 14, len: beatsOf("base") },
  ];
}

/** Full: the bubble flies (slow) and the reply rises; Reduced: both only fade (base). */
export function twinNotes(reduced: boolean): Note[] {
  return reduced
    ? [{ lane: 0, at: 0, len: beatsOf("base"), flat: true }, { lane: 1, at: 2, len: beatsOf("base"), flat: true }]
    : [{ lane: 0, at: 0, len: beatsOf("slow") }, { lane: 1, at: 2, len: beatsOf("base") }];
}

/** The token each score lane plays. */
export const SCORE_TOKENS = ["instant", "slow", "loop", "base", "base"] as const;
