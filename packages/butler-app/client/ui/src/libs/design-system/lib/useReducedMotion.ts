import { useEffect, useState } from "react";
import { prefersReducedMotion, subscribeReducedMotion } from "./motion";

/**
 * The effective reduced-motion preference (OS setting, the app override or
 * the DS Viewer scope), live. For blocks whose reduced look differs in kind
 * (a dot instead of a moving halo), not only in timing.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    setReduced(prefersReducedMotion());
    return subscribeReducedMotion(setReduced);
  }, []);
  return reduced;
}
