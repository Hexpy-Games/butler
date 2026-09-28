import type { ReactNode } from "react";
import type { Key, Track } from "../../heroTimeline";
import { BEATS, select } from "./typeChoreography";
import t from "./TypographyHero.module.css";

/**
 * Text that is revealed left to right: a window (`name`) and its content
 * (`name-in`) move in opposite directions in % of their own width, so no
 * measuring is needed. In the poster (no animation) the text simply shows.
 */
export function Reveal({ name, children }: { name: string; children: ReactNode }) {
  return (
    <span className={t.reveal} data-t={name}>
      <span className={t.revealIn} data-t={`${name}-in`}>{children}</span>
    </span>
  );
}

/**
 * Keys that open a Reveal from `at`, one decelerating step per character
 * (capped), holding open until `close` (while it is hidden) and closing there
 * for the next cycle.
 */
export function revealTracks(name: string, at: number, text: string | number, close = BEATS - 0.05): Track[] {
  const steps = Math.max(1, Math.min(24, typeof text === "number" ? text : [...text].length));
  const beat = Math.min(0.12, 2.4 / steps);
  const keys = (sign: number): Key[] => [
    { at: 0, xp: sign * 100 }, { at, xp: sign * 100 },
    ...Array.from({ length: steps }, (_, k): Key => ({ at: at + (k + 1) * beat, xp: sign * 100 * (1 - (k + 1) / steps), ease: "decelerate" })),
    { at: close - 0.01, xp: 0 }, { at: close, xp: sign * 100 },
  ];
  return [{ select: select(name), keys: keys(-1) }, { select: select(`${name}-in`), keys: keys(1) }];
}
