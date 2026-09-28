import type { Track } from "../../heroTimeline";
import { revealTracks } from "./Reveal";
import { FINALE, FLIGHTS } from "./typeChoreography";

/** Beats the role list's rungs rise at (see typeAssembly.ts). */
const riseAt = (i: number) => 20.6 + i * 0.4;

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
      ...revealTracks(`rt-${flight}`, riseAt(i) - 1, 8),
      // The H2 sample arrives by the match cut from the specimen; the rest reveal.
      ...(flight === "title" ? [] : revealTracks(`rf-${flight}`, riseAt(i) - 0.8, 16)),
      ...revealTracks(`rs-${flight}`, riseAt(i) - 0.4, 11),
    ]),
    ...revealTracks("rv-tnum", 29, 20),
    ...revealTracks("rv-family", FINALE + 2.8, 19),
    ...revealTracks("rv-axis", FINALE + 3.2, 6),
  ];
}
