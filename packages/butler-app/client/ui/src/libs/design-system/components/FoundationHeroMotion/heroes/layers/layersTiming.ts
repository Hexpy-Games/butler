import type { Key } from "../../heroTimeline";
import { HOLD, TRANSITION } from "../shared/beats";
import { SHEETS } from "./layersCopy";

/**
 * 09 Layers, "the exploded stack", beat marks:
 *
 *   0–6.8    Title     three offset copies of the word merge into one
 *   6.8–13   Flat      the Butler window, flat and complete: sidebar,
 *                      conversation, composer, titlebar, a dialog over its
 *                      scrim, the select open from it, a tooltip; no labels
 *   13–17    Tilt      the camera turns to a quarter view
 *   17–31    Separate  the page is named, then each sheet rises on its own
 *                      z, bottom to top, and its label hangs on its corner:
 *                      token, value, what lives there
 *   31–35.6  Read      the whole ladder holds
 *   35.6–38  Collapse  the labels leave; the sheets settle top to bottom
 *   38–44    Flat      the camera untilts to the flat window it was all along
 */
export const AT = {
  flat: 6.8,
  tilt: 13,
  named: 17.2,
  step: 2.4,
  rise: 1.2,
  close: 35.6,
  untilt: 38.2,
} as const;
export const END = AT.untilt + TRANSITION + HOLD.component;

/** The first cycle's keys, then a cut back to their first pose for the next one. */
export const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

/** When sheet k (1…) starts to rise; the page (0) is named as the tilt lands. */
export const risesAt = (k: number) => AT.named + k * AT.step - AT.rise;
export const namedAt = (k: number) => (k === 0 ? AT.named : risesAt(k) + AT.rise);
export const settlesAt = (k: number) => AT.close + 0.4 + (SHEETS.length - 1 - k) * 0.35;
