import type { Key, Pose, Track } from "../../heroTimeline";
import { select } from "../shared/Reveal";

/** Keys that return to the first pose at the cycle's close. */
export function looped(keys: Key[], close: number): Key[] {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
}

/** A part hidden until `at`, then arriving from `from` over `len` beats, held to the close. */
export function arrive(target: string, at: number, len: number, from: Pose, close: number, ease: Key["ease"] = "decelerate"): Track {
  const rest = Object.fromEntries(Object.keys(from).map((field) => [field, field === "s" ? 1 : 0])) as Pose;
  return { select: sel(target), keys: looped([{ at: 0, ...from, o: 0 }, { at, ...from, o: 0 }, { at: at + len, ...rest, o: 1, ease }], close) };
}

/** A `data-t` name, or a selector as is (a part inside a named one). */
export const sel = (target: string) => (/[[\s]/u.test(target) ? target : select(target));

/** A part inside a named one, by its product `data-test-class`. */
export const inside = (name: string, testClass: string) => `${select(name)} [data-test-class~="${testClass}"]`;

/** Shown (o 1) from `on` to `off` by short fades (`fade` beats), hidden otherwise. */
export function shown(target: string, on: number, off: number | null, close: number, fade = 0.2): Track {
  const keys: Key[] = [{ at: 0, o: 0 }, { at: on, o: 0 }, { at: on + fade, o: 1 }];
  if (off !== null) keys.push({ at: off, o: 1 }, { at: off + fade, o: 0 });
  return { select: sel(target), keys: looped(keys, close) };
}

/**
 * A note filling while it plays: its window and the fill inside move in
 * opposite directions (so the pill keeps its radius), linearly, in step with
 * the playhead. Each play empties the note first; the last one stays full.
 */
export function fillNote(name: string, plays: Array<[at: number, len: number]>, close: number): Track[] {
  const keys = (sign: number): Key[] => {
    const out: Key[] = [{ at: 0, xp: sign * 100 }];
    for (const [at, len] of plays) out.push({ at: at - 0.02 }, { at: at - 0.01, xp: sign * 100 }, { at: Math.max(at, 0), xp: sign * 100 }, { at: at + len, xp: 0, ease: "linear" });
    return looped(out, close);
  };
  return [{ select: select(name), keys: keys(-1) }, { select: select(`${name}-in`), keys: keys(1) }];
}

/** A playhead sweeping its rail from `at` over `len` beats, shown only while it plays. */
export function playhead(name: string, at: number, len: number, close: number): Track {
  return {
    select: select(name),
    keys: looped([{ at: 0, xp: 0, o: 0 }, { at: at - 0.2, xp: 0, o: 0 }, { at, o: 1 }, { at: at + len, xp: 100, ease: "linear" }, { at: at + len + 0.5, o: 0 }], close),
  };
}
