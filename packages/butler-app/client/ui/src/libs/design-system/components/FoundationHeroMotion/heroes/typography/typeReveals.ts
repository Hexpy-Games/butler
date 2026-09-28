import type { Track } from "../../heroTimeline";
import { ROW } from "../shared/beats";
import { revealTracks } from "./Reveal";
import { FINALE, FLIGHTS, TRANSITION } from "./typeChoreography";

/**
 * When row `i` of the role list starts building: the H2 row lands by the
 * match cut at 20.2; the camera closes in on it over one TRANSITION, then a
 * row every ROW beats, each starting before the previous one has finished.
 */
export { ROW };
export const rowAt = (i: number) => (i === 0 ? 20.2 : 20.2 + TRANSITION + (i - 1) * ROW);

/**
 * When every label outside the component builds reveals, left to right: the
 * opening's guide values and weight control, the role list's tags, samples
 * and specs, the family caption and the tabular-numerals note. Nothing is on
 * screen before its moment.
 */
export function revealAll(): Track[] {
  return [
    ...["base", "cap", "xh", "asc", "desc"].flatMap((name, k) => revealTracks(`rv-h-${name}`, 2.4 + k * 0.3, 14)),
    ...revealTracks("rv-size", 2.2, 24),
    ...revealTracks("rv-adv-a", 3.2, 14),
    ...revealTracks("rv-adv-g", 3.5, 14),
    ...revealTracks("rv-gap", 3.6, 20),
    ...revealTracks("rv-fw", 9, 11),
    ...revealTracks("rv-45", 9.3, 2),
    ...revealTracks("rv-920", 9.5, 3),
    ...revealTracks("rv-token", 16.2, 20),
    ...FLIGHTS.flatMap((flight, i) => [
      // Row by row: tag, then the text (the H2 arrives by the match cut), then its spec once the styles apply.
      ...revealTracks(`rt-${flight}`, rowAt(i), 8),
      ...(flight === "title" ? [] : revealTracks(`rf-${flight}`, rowAt(i) + 0.2, 16)),
      ...revealTracks(`rs-${flight}`, rowAt(i) + 1.5, 11),
    ]),
    ...revealTracks("rv-tnum", rowAt(6) + 1.8, 20),
    ...revealTracks("rv-family", FINALE + 2.8, 19),
    ...revealTracks("rv-axis", FINALE + 3.2, 6),
  ];
}
