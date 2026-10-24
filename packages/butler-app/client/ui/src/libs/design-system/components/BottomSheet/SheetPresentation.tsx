import * as React from "react";
import { cn } from "../../lib/utils";
import { tintedGlassSurfaceClassName } from "../TintedGlass";
import { SheetHandle } from "./BottomSheet";
import { useKeyboardInset } from "./sheetBehavior";
import { dismissLikeEscape, loopSheetFocus } from "./sheetFocus";
import styles from "./BottomSheet.module.css";
import { useReducedMotion } from "../../lib/useReducedMotion";

/**
 * Props that make a Radix DropdownMenu, Popover or Select content open as a
 * BottomSheet (see sheet-presentation.css): it keeps Radix's keyboard,
 * typeahead and dismissal, and only changes placement and chrome.
 */
export function sheetContentProps(className: string | undefined, onKeyDown: React.KeyboardEventHandler<HTMLDivElement> | undefined) {
  return {
    "data-presentation": "sheet",
    "data-glass": "popover",
    "data-radius": "popover",
    side: "bottom" as const,
    align: "center" as const,
    sideOffset: 0,
    avoidCollisions: false,
    className: cn(tintedGlassSurfaceClassName, styles.surface, className),
    onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      loopSheetFocus(event);
    },
  };
}

/** Grabber row for a presented sheet; a dismissing drag closes it the way Escape does. */
export function PresentedSheetHandle({ surfaceRef }: { surfaceRef: React.RefObject<HTMLElement | null> }) {
  useKeyboardInset(surfaceRef, true);
  const reduced = useReducedMotion();
  React.useEffect(() => {
    surfaceRef.current?.toggleAttribute("data-reduced", reduced);
  }, [reduced, surfaceRef]);
  return <SheetHandle surfaceRef={surfaceRef} onClose={() => dismissLikeEscape(surfaceRef.current)} />;
}

/** Scrolling body of a presented sheet, with room for focus rings. */
export function PresentedSheetBody({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <div className={cn(styles.body, className)} data-slot="bottom-sheet-body">{children}</div>;
}

export const presentedSheetBodyClassName = styles.body;
