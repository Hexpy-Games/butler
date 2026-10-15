import { useMemo, useSyncExternalStore } from "react";
import { floatingContentCollisionPadding } from "./floatingConstraints";

/** Popover.module.css turns popovers into screen-wide sheets at this width. */
export const POPOVER_SHEET_QUERY = "(width <= 640px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia(POPOVER_SHEET_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True while popovers render as mobile sheets. */
export function usePopoverSheet(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(POPOVER_SHEET_QUERY).matches, () => false);
}

type Side = "top" | "right" | "bottom" | "left";

/** A sheet spans the screen, so a left or right side has no room: it opens below instead. */
export function sheetSide(sheet: boolean, side: Side | undefined): Side | undefined {
  return sheet && (side === "left" || side === "right") ? "bottom" : side;
}

function safeAreaInsets(): { left: number; right: number; bottom: number } {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;"
    + "padding:0 env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const insets = { left: parseFloat(style.paddingLeft) || 0, right: parseFloat(style.paddingRight) || 0, bottom: parseFloat(style.paddingBottom) || 0 };
  probe.remove();
  return insets;
}

/** Collision padding that keeps a sheet clear of the side and bottom safe areas (notch, home indicator). */
export function useSheetCollisionPadding(sheet: boolean) {
  return useMemo(() => {
    if (!sheet) return floatingContentCollisionPadding;
    const insets = safeAreaInsets();
    return {
      top: floatingContentCollisionPadding.top,
      left: floatingContentCollisionPadding.left + insets.left,
      right: floatingContentCollisionPadding.right + insets.right,
      bottom: floatingContentCollisionPadding.bottom + insets.bottom,
    };
  }, [sheet]);
}
