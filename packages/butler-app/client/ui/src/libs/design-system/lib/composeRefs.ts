import { useCallback, type Ref, type RefCallback } from "react";

type RefCleanup = () => void;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): RefCleanup | void {
  if (typeof ref === "function") return ref(value) ?? undefined;
  if (ref) (ref as { current: T | null }).current = value;
}

/** Stable callback ref that forwards to every ref and honors ref cleanups. */
export function useComposedRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  return useCallback((value: T | null) => {
    const cleanups = refs.map((ref) => assignRef(ref, value));
    return () => {
      refs.forEach((ref, index) => {
        const cleanup = cleanups[index];
        if (typeof cleanup === "function") cleanup();
        else assignRef(ref, null);
      });
    };
  }, refs);
}
