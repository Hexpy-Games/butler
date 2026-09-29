import type { Key, Track } from "../../heroTimeline";
import { revealTracks as sharedRevealTracks, sweep as sharedSweep } from "../shared/Reveal";
import { BEATS } from "./typeChoreography";

/** The shared left-to-right reveal (see ../shared/Reveal.tsx); these bind its close to this hero's cycle. */
export { Reveal } from "../shared/Reveal";

export function sweep(at: number, beats: number, close = BEATS - 0.05): { outer: Key[]; inner: Key[] } {
  return sharedSweep(at, beats, close);
}

export function revealTracks(name: string, at: number, text: string | number, close = BEATS - 0.05): Track[] {
  return sharedRevealTracks(name, at, text, close);
}
