import { useSyncExternalStore } from "react";

const query = "(prefers-reduced-motion: reduce)";
const read = () => window.matchMedia?.(query).matches ?? false;
const subscribe = (notify: () => void) => {
  const media = window.matchMedia?.(query);
  if (!media) return () => undefined;
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
