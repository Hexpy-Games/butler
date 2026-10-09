import { useCallback, useState } from "react";
import { prefersReducedMotion } from "../../lib/motion";
import { overlap, type PathRect } from "./pointerPath";

export interface TargetRing { key: number; rect: PathRect }

interface RingState { last?: PathRect; key: number; leaving: TargetRing[] }

const sameRect = (a?: PathRect, b?: PathRect) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

/**
 * Target rings never morph: each target gets its own ring, drawn at its final geometry from the first
 * frame. A new target (overlap under 85%) gets a new key, so its ring mounts in place and fades in while
 * the old one fades out where it was; the same element re-measured keeps its key and moves instantly.
 * Under reduced motion the old ring goes at once.
 */
export function useTargetRings(target: PathRect | undefined, reduced: boolean) {
  const [state, setState] = useState<RingState>(() => ({ last: target, key: 0, leaving: [] }));
  if (!sameRect(state.last, target)) {
    const moved = !state.last || !target || overlap(state.last, target) < 0.85;
    const keep = !reduced && !prefersReducedMotion();
    const leaving = moved && state.last && keep ? [...state.leaving.slice(-1), { key: state.key, rect: state.last }] : moved ? [] : state.leaving;
    // Derived state: React re-renders at once, before anything paints.
    setState({ last: target, key: moved ? state.key + 1 : state.key, leaving });
  }
  const drop = useCallback((key: number) => setState((current) => ({ ...current, leaving: current.leaving.filter((ring) => ring.key !== key) })), []);
  return { current: target ? { key: state.key, rect: target } : undefined, leaving: state.leaving, drop };
}
