import { useSyncExternalStore } from "react";

/**
 * How a DropdownMenuContent, PopoverContent or SelectContent opens.
 * `popover`: anchored to its trigger (at 640px and narrower Popover's attached sheet).
 * `sheet`: always a BottomSheet. `auto`: a BottomSheet below 768px, anchored above.
 */
export type OverlayPresentation = "auto" | "popover" | "sheet";

/** The app-wide default; switching it to `auto` makes every menu a BottomSheet on phones. */
export const DEFAULT_OVERLAY_PRESENTATION: OverlayPresentation = "popover";

/** `auto` opens a BottomSheet below this width. */
export const BOTTOM_SHEET_QUERY = "(width < 768px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(BOTTOM_SHEET_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function narrow(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(BOTTOM_SHEET_QUERY).matches;
}

const fixed = () => () => undefined;
const never = () => false;

/** True when an overlay with this presentation renders as a BottomSheet right now; only `auto` watches the width. */
export function useSheetPresentation(presentation: OverlayPresentation = DEFAULT_OVERLAY_PRESENTATION): boolean {
  const watches = presentation === "auto" && typeof window !== "undefined" && typeof window.matchMedia === "function";
  const isNarrow = useSyncExternalStore(watches ? subscribe : fixed, watches ? narrow : never, never);
  return presentation === "sheet" || (presentation === "auto" && isNarrow);
}
