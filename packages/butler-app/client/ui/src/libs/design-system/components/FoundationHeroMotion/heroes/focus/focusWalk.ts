import type { Key, Pose, Track } from "../../heroTimeline";
import { select } from "../shared/Reveal";
import type { Marks } from "../shared/types";
import type { KeyId } from "./FocusScenes";

/** How a stop shows focus, as the DS draws it: the ring (--focus-ring), the base outline (2px at 1px off), a text field's caret. */
export type Kind = "ring" | "outline" | "caret";
export type Press = [at: number, key: KeyId, stop: string, kind: Kind];

/** Keys that close the cycle: back to the first key's values. */
export const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

/** The ring's pose on a mark: its box and corner, as the DS draws it (the outline stands 1px off the control). */
export function on(marks: Marks, name: string, kind: Kind = "ring"): Pose {
  const m = marks[name];
  if (!m) return { x: 0, y: 0, w: 20, h: 20, rad: 8 };
  const off = kind === "outline" ? 1 : 0;
  return { x: m.box.x - off, y: m.box.y - off, w: m.box.w + off * 2, h: m.box.h + off * 2, rad: Math.min(m.r, m.box.h / 2) + off };
}

export const shows = (kind: Kind) => kind === "ring" || kind === "outline";

/**
 * A ring walking stops: it slides between stops that draw a ring, fades out
 * where focus shows otherwise (a text field's caret) and fades back in at the
 * next ring.
 */
export function walk(name: string, marks: Marks, presses: Press[], start: number, close: number): Track {
  const poses = presses.map(([, , stop, kind]) => on(marks, stop, kind));
  const keys: Key[] = [{ at: 0, ...poses[0]!, o: 0 }];
  presses.forEach(([at, , , kind], k) => {
    const t = start + at;
    const pose = poses[k]!;
    const was = k > 0 ? presses[k - 1]![3] : null;
    if (was === null || !shows(was)) {
      if (shows(kind)) keys.push({ at: t, ...pose, o: 0 }, { at: t + 0.3, o: 1 });
      return;
    }
    if (shows(kind)) keys.push({ at: t, ...poses[k - 1]!, o: 1 }, { at: t + 0.5, ...pose, o: 1, ease: "standard" });
    else keys.push({ at: t, o: 1 }, { at: t + 0.3, o: 0 });
  });
  return { select: select(name), keys: looped(keys, close) };
}

/** Key cap layers: each shows from its press until the next press, pressing in as it lands. */
export function keyCaps(prefix: string, presses: Press[], start: number, ids: KeyId[], until: number, close: number): Track[] {
  return ids.map((id): Track => {
    const keys: Key[] = [{ at: 0, o: 0, s: 1 }];
    presses.forEach(([at, key], k) => {
      if (key !== id) return;
      // The same key pressed again stays up and presses in once more (no cut between).
      const again = k > 0 && presses[k - 1]![1] === id;
      const held = k + 1 < presses.length && presses[k + 1]![1] === id;
      const next = k + 1 < presses.length ? start + presses[k + 1]![0] : until;
      keys.push(...(again ? [{ at: start + at - 0.01, s: 1 }] : [{ at: start + at - 0.01, o: 0, s: 1 }]), { at: start + at, o: 1, s: 0.9 }, { at: start + at + 0.3, s: 1, ease: "standard" });
      if (!held) keys.push({ at: next - 0.01, o: 1 }, { at: next, o: 0 });
    });
    return { select: select(`${prefix}-${id}`), keys: looped(keys, close) };
  });
}

/** A layer cut on and off at beats (no fade: a state changes at once). */
export function cuts(name: string, first: 0 | 1, at: number[], close: number): Track {
  const keys: Key[] = [{ at: 0, o: first }];
  at.forEach((t, k) => {
    const o = (k % 2 === 0 ? 1 - first : first);
    keys.push({ at: t - 0.01, o: 1 - o }, { at: t, o });
  });
  return { select: select(name), keys: looped(keys, close) };
}
