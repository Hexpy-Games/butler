import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createSidebarPeekController, PEEK_DISMISS_MS, type SidebarPeekCloseReason, type SidebarPeekPoint } from "./sidebarPeek";

export interface UseSidebarPeekOptions {
  /** Peek is possible (the sidebar is collapsed and not a drawer); turning it off closes the peek. */
  enabled: boolean;
  /** Controlled state; omit to let the hook own it. */
  open?: boolean;
  onOpenChange?: (open: boolean, reason?: SidebarPeekCloseReason) => void;
  dismissMs?: number;
}

export interface SidebarPeek {
  /** Pass to AdaptiveShell `leftPeek`. */
  open: boolean;
  /** Pass to AdaptiveShellPeekEdge `onPeek`. */
  show: () => void;
  close: (reason?: SidebarPeekCloseReason) => void;
  /** Host-reported pointer position in window CSS px (e.g. from the main process while over a native view). */
  pointerAt: (point: SidebarPeekPoint) => void;
  /** Host signal: the pointer is over a surface the DOM cannot see (a native page view). */
  pointerOutside: () => void;
}

/**
 * The collapsed sidebar's peek for an AdaptiveShell (`rootRef` = the shell). DOM signals close it
 * (pointer leaving the sidebar after a short delay, window blur, Escape, a press outside, the pointer
 * leaving the document). A native view (Electron WebContentsView) hides the pointer from the DOM, so
 * the App forwards the host's signal: `pointerOutside()` when the pointer enters the native view, or
 * `pointerAt(point)` with positions it tracks. No Electron imports here.
 */
export function useSidebarPeek(rootRef: RefObject<HTMLElement | null>, { enabled, open: controlled, onOpenChange, dismissMs = PEEK_DISMISS_MS }: UseSidebarPeekOptions): SidebarPeek {
  const [own, setOwn] = useState(false);
  const open = enabled && (controlled ?? own);
  const callback = useRef(onOpenChange);
  callback.current = onOpenChange;
  const controller = useMemo(() => createSidebarPeekController({
    sidebar: () => rootRef.current?.querySelector('[data-slot="adaptive-shell-sidebar"]') ?? null,
    onChange: (next, reason) => { setOwn(next); callback.current?.(next, reason); },
    dismissMs,
  }), [rootRef, dismissMs]);

  useEffect(() => controller.sync(open), [controller, open]);
  useEffect(() => { if (!enabled) controller.close("disabled"); }, [controller, enabled]);
  useEffect(() => controller.dispose, [controller]);

  useEffect(() => {
    const sidebar = rootRef.current?.querySelector<HTMLElement>('[data-slot="adaptive-shell-sidebar"]');
    if (!open || !sidebar) return undefined;
    const doc = sidebar.ownerDocument;
    const view = doc.defaultView ?? window;
    const onBlur = () => controller.close("window-blur");
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") controller.close("escape"); };
    const onPress = (event: PointerEvent) => { if (!sidebar.contains(event.target as Node)) controller.close("press-outside"); };
    const listeners: Array<[EventTarget, string, EventListener, boolean]> = [
      [sidebar, "pointerenter", controller.pointerEnter as EventListener, false],
      [sidebar, "pointerleave", controller.pointerLeave as EventListener, false],
      [doc.documentElement, "mouseleave", controller.pointerOutside as EventListener, false],
      [view, "blur", onBlur as EventListener, false],
      [doc, "keydown", onKey as EventListener, true],
      [doc, "pointerdown", onPress as EventListener, true],
    ];
    for (const [target, type, listener, capture] of listeners) target.addEventListener(type, listener, capture);
    return () => { for (const [target, type, listener, capture] of listeners) target.removeEventListener(type, listener, capture); };
  }, [controller, open, rootRef]);

  return useMemo(() => ({
    open,
    show: () => { if (enabled) controller.show(); },
    close: (reason: SidebarPeekCloseReason = "pointer-left") => controller.close(reason),
    pointerAt: controller.pointerAt,
    pointerOutside: controller.pointerOutside,
  }), [controller, enabled, open]);
}
