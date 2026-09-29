import type { ReactNode } from "react";
import type { Key, Track } from "../../heroTimeline";
import s from "./shared.module.css";

/** Selector of a hero part by its `data-t` name. */
export function select(name: string): string {
  return `[data-t="${name}"]`;
}

/**
 * Text that is revealed left to right: a window (`name`) and its content
 * (`name-in`) move in opposite directions in % of their own width, so no
 * measuring is needed. In the poster (no animation) the text simply shows.
 * `data-rv` carries the name so a hero can count the characters it reveals.
 */
export function Reveal({ name, children }: { name: string; children: ReactNode }) {
  return (
    <span className={s.reveal} data-rv={name} data-t={name}>
      <span className={s.revealIn} data-t={`${name}-in`}>{children}</span>
    </span>
  );
}

/**
 * A window sweeping open left to right over `beats` (one decelerating move),
 * for shapes such as a leading band: translating a window keeps the shape's
 * corner radius, where scaling it would distort it. Closes at `close`.
 */
export function sweep(at: number, beats: number, close: number): { outer: Key[]; inner: Key[] } {
  const keys = (sign: number): Key[] => [
    { at: 0, xp: sign * 100 }, { at, xp: sign * 100 }, { at: at + beats, xp: 0, ease: "emphasized" }, { at: close - 0.01, xp: 0 }, { at: close, xp: sign * 100 },
  ];
  return { outer: keys(-1), inner: keys(1) };
}

/**
 * Keys that open a Reveal from `at`, one decelerating step per character
 * (capped), holding open until `close` (while it is hidden) and closing there
 * for the next cycle.
 */
export function revealTracks(name: string, at: number, text: string | number, close: number, cap = 24): Track[] {
  const steps = Math.max(1, Math.min(cap, typeof text === "number" ? text : [...text].length));
  const beat = Math.min(0.12, 2.4 / steps);
  const keys = (sign: number): Key[] => [
    { at: 0, xp: sign * 100 }, { at, xp: sign * 100 },
    ...Array.from({ length: steps }, (_, k): Key => ({ at: at + (k + 1) * beat, xp: sign * 100 * (1 - (k + 1) / steps), ease: "decelerate" })),
    { at: close - 0.01, xp: 0 }, { at: close, xp: sign * 100 },
  ];
  return [{ select: select(name), keys: keys(-1) }, { select: select(`${name}-in`), keys: keys(1) }];
}

/** Reveal steps of the chapter heroes: at most one per character, capped (a long label opens a few glyphs per step). */
export const STEP_CAP = 12;

/** A chapter hero's left-to-right reveal (capped steps). */
export function reveal(name: string, at: number, text: string | number, close: number): Track[] {
  return revealTracks(name, at, text, close, STEP_CAP);
}

/** Beats a Reveal of `chars` characters takes to open fully. */
export function revealBeats(chars: number, cap = STEP_CAP): number {
  const steps = Math.max(1, Math.min(cap, chars));
  return steps * Math.min(0.12, 2.4 / steps);
}
