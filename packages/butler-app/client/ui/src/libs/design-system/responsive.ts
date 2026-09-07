import { useCallback, useSyncExternalStore } from "react";

export type ChromeEnvironment = "browser" | "electron";

export const ADAPTIVE_BREAKPOINTS = {
  compactMax: 640,
  mediumMax: 1023,
} as const;

export const ADAPTIVE_MEDIA = {
  compact: `(max-width: ${ADAPTIVE_BREAKPOINTS.compactMax}px)`,
  medium: `(min-width: ${ADAPTIVE_BREAKPOINTS.compactMax + 1}px) and (max-width: ${ADAPTIVE_BREAKPOINTS.mediumMax}px)`,
  expanded: `(min-width: ${ADAPTIVE_BREAKPOINTS.mediumMax + 1}px)`,
  coarse: "(pointer: coarse)",
} as const;

export type AdaptiveMode = "compact" | "medium" | "expanded";
export type AdaptivePanel = "left" | "right";

export function classifyAdaptiveMode(width: number, environment: ChromeEnvironment = "browser"): AdaptiveMode {
  if (width <= ADAPTIVE_BREAKPOINTS.compactMax) return "compact";
  if (environment === "electron") return "expanded";
  if (width <= ADAPTIVE_BREAKPOINTS.mediumMax) return "medium";
  return "expanded";
}

export function currentAdaptiveMode(environment: ChromeEnvironment = "browser"): AdaptiveMode {
  if (typeof window === "undefined") return "expanded";
  return classifyAdaptiveMode(window.innerWidth, environment);
}

export function adaptiveDrawerQuery(environment: ChromeEnvironment): string {
  return environment === "electron" ? ADAPTIVE_MEDIA.compact : `(max-width: ${ADAPTIVE_BREAKPOINTS.mediumMax}px)`;
}

/** CSS shell and product panel state share the same environment-aware breakpoint. */
export function useAdaptiveDrawer(environment: ChromeEnvironment): boolean {
  const query = adaptiveDrawerQuery(environment);
  const subscribe = useCallback((notify: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener("change", notify);
    return () => media.removeEventListener("change", notify);
  }, [query]);
  const read = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, read, () => false);
}

export function normalizeAdaptivePanelState({
  mode,
  requested,
  leftOpen,
  rightOpen,
}: {
  mode: AdaptiveMode;
  requested: AdaptivePanel;
  leftOpen: boolean;
  rightOpen: boolean;
}): { leftOpen: boolean; rightOpen: boolean } {
  if (mode === "expanded") {
    return requested === "left"
      ? { leftOpen: true, rightOpen }
      : { leftOpen, rightOpen: true };
  }
  return requested === "left"
    ? { leftOpen: true, rightOpen: false }
    : { leftOpen: false, rightOpen: true };
}

export function restoreAdaptivePanelState({
  mode,
  leftOpen,
  rightOpen,
}: {
  mode: AdaptiveMode;
  leftOpen: boolean;
  rightOpen: boolean;
}): { leftOpen: boolean; rightOpen: boolean } {
  return mode === "expanded"
    ? { leftOpen, rightOpen }
    : { leftOpen: false, rightOpen: false };
}
