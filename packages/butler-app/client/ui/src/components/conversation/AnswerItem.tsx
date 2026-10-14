import { useLayoutEffect, useRef, type ReactNode } from "react";
import { animateMotion, Grid, Presence } from "@/butler-ds";

/** Retain the item's DOM during retries, but distinguish values not yet replaced by this call. */
export function useAnswerItemRef<T extends HTMLElement>(superseded: boolean) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (!ref.current || !superseded) return;
    const animation = animateMotion(ref.current, [{ opacity: 0.45 }, { opacity: 0.45 }], { duration: "instant", fill: "both" });
    return () => animation?.cancel();
  }, [superseded]);
  return ref;
}

export function AnswerItem({ superseded, children }: { superseded: boolean; children: ReactNode }) {
  const ref = useAnswerItemRef<HTMLElement>(superseded);
  return <Presence present motion="rise"><Grid ref={ref} columns="1" gap="none" data-answer-superseded={superseded || undefined}>{children}</Grid></Presence>;
}
