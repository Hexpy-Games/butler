/** How long the pointer may be away from the peeked sidebar before it closes. */
export const PEEK_DISMISS_MS = 240;

export type SidebarPeekCloseReason = "pointer-left" | "pointer-outside" | "window-blur" | "escape" | "press-outside" | "disabled";

export interface SidebarPeekPoint { x: number; y: number }

export interface SidebarPeekControllerOptions {
  /** The peeked sidebar element (its rect decides host-reported pointer positions). */
  sidebar: () => Element | null;
  onChange: (open: boolean, reason?: SidebarPeekCloseReason) => void;
  dismissMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

/**
 * The sidebar peek's open/close logic, free of the DOM event wiring (useSidebarPeek adds that) and of
 * Electron. The pointer leaving the sidebar, or a host report that it is elsewhere (over a native
 * view the DOM cannot see), arms a short dismiss timer that coming back cancels; window blur, Escape and
 * a press outside close at once.
 */
export function createSidebarPeekController({
  sidebar, onChange, dismissMs = PEEK_DISMISS_MS, setTimer = (run, ms) => setTimeout(run, ms), clearTimer = (timer) => clearTimeout(timer as number),
}: SidebarPeekControllerOptions) {
  let open = false;
  let timer: unknown = null;
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const close = (reason: SidebarPeekCloseReason) => {
    cancel();
    if (!open) return;
    open = false;
    onChange(false, reason);
  };
  const arm = (reason: SidebarPeekCloseReason) => {
    if (!open || timer !== null) return;
    timer = setTimer(() => { timer = null; close(reason); }, dismissMs);
  };
  const inside = (point: SidebarPeekPoint) => {
    const rect = sidebar()?.getBoundingClientRect();
    return Boolean(rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom);
  };
  return {
    isOpen: () => open,
    /** A controlled owner changed the state: follow it without reporting back. */
    sync(next: boolean) {
      if (!next) cancel();
      open = next;
    },
    /** Opens (the left-edge hover zone). */
    show() {
      cancel();
      if (open) return;
      open = true;
      onChange(true);
    },
    close,
    /** The pointer entered the sidebar: stay open. */
    pointerEnter: cancel,
    /** The pointer left the sidebar for another DOM surface. */
    pointerLeave: () => arm("pointer-left"),
    /** A host-reported pointer position in window CSS pixels (e.g. while over a native page view). */
    pointerAt(point: SidebarPeekPoint) {
      if (inside(point)) cancel();
      else arm("pointer-outside");
    },
    /** The host says the pointer is over a surface the DOM cannot see (a native view). */
    pointerOutside: () => arm("pointer-outside"),
    dispose: cancel,
  };
}

export type SidebarPeekController = ReturnType<typeof createSidebarPeekController>;
