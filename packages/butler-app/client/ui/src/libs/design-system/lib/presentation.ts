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
  return window.matchMedia(BOTTOM_SHEET_QUERY).matches;
}

/** True when an overlay with this presentation renders as a BottomSheet right now. */
export function useSheetPresentation(presentation: OverlayPresentation = DEFAULT_OVERLAY_PRESENTATION): boolean {
  const isNarrow = useSyncExternalStore(subscribe, narrow, () => false);
  return presentation === "sheet" || (presentation === "auto" && isNarrow);
}
