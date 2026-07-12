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

export function classifyAdaptiveMode(width: number): AdaptiveMode {
  if (width <= ADAPTIVE_BREAKPOINTS.compactMax) return "compact";
  if (width <= ADAPTIVE_BREAKPOINTS.mediumMax) return "medium";
  return "expanded";
}

export function currentAdaptiveMode(): AdaptiveMode {
  if (typeof window === "undefined") return "expanded";
  return classifyAdaptiveMode(window.innerWidth);
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
