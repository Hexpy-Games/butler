import { MorphSim } from "./thinking-mark/motion";

interface SharedMorph {
  sim: MorphSim;
  holders: number;
}

const shared = new Map<string, SharedMorph>();

/**
 * Holds the morph simulation for a mark. Marks with the same `morphKey` share one
 * simulation, so when a product remounts the mark mid-work (pending -> current
 * status, a different parent) the new mark continues the morph and the motion
 * where the old one was, instead of restarting from the logo. Without a key the
 * mark keeps its own simulation. Returns the release for the effect cleanup.
 */
export function holdMorph(key: string | undefined, ref: { current: MorphSim | null }): () => void {
  if (!key) {
    ref.current ??= new MorphSim();
    return () => undefined;
  }
  let entry = shared.get(key);
  if (!entry) {
    // A mark that just gained a key keeps its own morph going under it.
    entry = { sim: ref.current ?? new MorphSim(), holders: 0 };
    shared.set(key, entry);
  }
  const held = entry;
  held.holders += 1;
  ref.current = held.sim;
  return () => {
    held.holders -= 1;
    // A remount releases and re-holds in the same commit; forget the key only if nobody took it back.
    queueMicrotask(() => {
      if (held.holders === 0 && shared.get(key) === held) shared.delete(key);
    });
  };
}

/** Keys currently holding a shared morph; for tests. */
export function heldMorphKeys() {
  return [...shared.keys()];
}
