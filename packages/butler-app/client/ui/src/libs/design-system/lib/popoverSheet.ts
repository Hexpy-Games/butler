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

type Insets = { left: number; right: number; bottom: number };

const NO_INSETS: Insets = { left: 0, right: 0, bottom: 0 };
/** Safe-area insets change only with orientation; a sheet-width change re-measures too. */
const INSET_QUERIES = [POPOVER_SHEET_QUERY, "(orientation: portrait)"];
let insets: Insets = NO_INSETS;
let measured = false;

/** Resolves env(safe-area-inset-*) through a hidden probe; called outside render only. */
function measureInsets(): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  measured = true;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;"
    + "padding:0 env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const next = { left: parseFloat(style.paddingLeft) || 0, right: parseFloat(style.paddingRight) || 0, bottom: parseFloat(style.paddingBottom) || 0 };
  probe.remove();
  if (next.left === insets.left && next.right === insets.right && next.bottom === insets.bottom) return false;
  insets = next;
  return true;
}

const insetListeners = new Set<() => void>();

// Measured once at load and again only when a media query that can move the
// safe areas changes; the module-lifetime listeners are shared by every popover.
measureInsets();
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const refresh = () => { if (measureInsets()) for (const listener of insetListeners) listener(); };
  for (const query of INSET_QUERIES) window.matchMedia(query).addEventListener("change", refresh);
}

function subscribeInsets(onChange: () => void) {
  insetListeners.add(onChange);
  // The module loaded before <body> existed: measure once, after commit.
  if (!measured && measureInsets()) onChange();
  return () => { insetListeners.delete(onChange); };
}

/** Collision padding that keeps a sheet clear of the side and bottom safe areas (notch, home indicator). */
export function useSheetCollisionPadding(sheet: boolean) {
  const current = useSyncExternalStore(subscribeInsets, () => insets, () => NO_INSETS);
  return useMemo(() => {
    if (!sheet) return floatingContentCollisionPadding;
    return {
      top: floatingContentCollisionPadding.top,
      left: floatingContentCollisionPadding.left + current.left,
      right: floatingContentCollisionPadding.right + current.right,
      bottom: floatingContentCollisionPadding.bottom + current.bottom,
    };
  }, [sheet, current]);
}
