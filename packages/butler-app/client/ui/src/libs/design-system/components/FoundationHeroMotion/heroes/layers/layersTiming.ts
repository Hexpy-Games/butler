import type { Key } from "../../heroTimeline";
import { HOLD, TRANSITION } from "../shared/beats";

/**
 * 09 Layers, "the exploded stack", beat marks:
 *
 *   0–6.8    Title     three offset copies of the word merge into one
 *   6.8–13   Flat      the Butler window, flat and complete: sidebar,
 *                      conversation, composer, titlebar, a dialog over its
 *                      scrim, the select open from it, a tooltip; no labels
 *   13–17    Tilt      the camera turns to a quarter view
 *   17.4–20.6 Spread   every sheet leaves the page together, in one smooth
 *                      spread along z, while the camera moves in on the stack
 *   20.9–24  Read      the labels hang on the corners, bottom to top, a
 *                      short stagger: token, value, what lives there
 *   24–33.4  Hold      the whole ladder holds
 *   33.4–37  Collapse  the labels leave; all sheets settle together and the
 *                      camera backs out to the quarter view
 *   38–44    Flat      the camera untilts to the flat window it was all along
 */
export const AT = {
  flat: 6.8,
  tilt: 13,
  spread: 17.4,
  spreadFor: 3.2,
  label: 20.9,
  labelStep: 0.5,
  close: 33.4,
  collapse: 33.9,
  collapseFor: 3.2,
  untilt: 38.2,
} as const;
export const END = AT.untilt + TRANSITION + HOLD.component;

/** The first cycle's keys, then a cut back to their first pose for the next one. */
export const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

/** When sheet k's label hangs (the page's first, then up the ladder). */
export const labelAt = (k: number) => AT.label + k * AT.labelStep;
