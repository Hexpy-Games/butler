import { useEffect, useRef, type PointerEvent, type RefObject } from "react";

/** Share of the sheet's height a drag must travel down to dismiss it. */
const DISMISS_SHARE = 0.3;
/** px/ms: a flick this fast dismisses (down) or expands (up) whatever the distance. */
const FLICK_VELOCITY = 0.5;
/** px: travel that turns a press into a drag (the grabber's tap then does nothing). */
const DRAG_SLOP = 4;
/** px: upward travel that expands an expandable sheet. */
const EXPAND_DISTANCE = 48;

type DragState = { id: number; startY: number; lastY: number; lastTime: number; velocity: number; height: number };

export type SheetDragOptions = {
  expandable: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onDismiss: () => void;
};

function setOffset(surface: HTMLElement | null, offset: number | null) {
  if (!surface) return;
  if (offset === null) {
    surface.removeAttribute("data-dragging");
    return;
  }
  surface.setAttribute("data-dragging", "");
  surface.style.setProperty("--sheet-drag-y", `${offset}px`);
}

function settle(surface: HTMLElement | null) {
  setOffset(surface, null);
  surface?.style.removeProperty("--sheet-drag-y");
}

/**
 * Drag on the handle row: the sheet follows the finger down (and up while it
 * can expand; otherwise it resists), then dismisses, changes detent or springs
 * back. Pointer moves write a CSS variable only, never React state.
 */
export function useSheetDrag(surfaceRef: RefObject<HTMLElement | null>, options: SheetDragOptions) {
  const drag = useRef<DragState | null>(null);
  const moved = useRef(false);
  const latest = useRef(options);
  latest.current = options;

  const release = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    drag.current = null;
    const { expandable, expanded, onExpandedChange, onDismiss } = latest.current;
    const distance = event.clientY - state.startY;
    const flickDown = state.velocity > FLICK_VELOCITY && distance > DRAG_SLOP;
    const flickUp = state.velocity < -FLICK_VELOCITY && distance < -DRAG_SLOP;
    if (expandable && expanded && !flickDown && distance > EXPAND_DISTANCE && distance < state.height * 0.6) {
      settle(surfaceRef.current);
      onExpandedChange(false);
    } else if (distance > state.height * DISMISS_SHARE || flickDown) {
      // Keep the offset: the exit animation starts where the finger let go.
      surfaceRef.current?.removeAttribute("data-dragging");
      onDismiss();
    } else if (expandable && !expanded && (distance < -EXPAND_DISTANCE || flickUp)) {
      settle(surfaceRef.current);
      onExpandedChange(true);
    } else {
      settle(surfaceRef.current);
    }
  };

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      const surface = surfaceRef.current;
      if (event.button !== 0 || !surface) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      moved.current = false;
      drag.current = {
        id: event.pointerId,
        startY: event.clientY,
        lastY: event.clientY,
        lastTime: event.timeStamp,
        velocity: 0,
        height: surface.getBoundingClientRect().height,
      };
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const state = drag.current;
      if (!state || state.id !== event.pointerId) return;
      const elapsed = Math.max(1, event.timeStamp - state.lastTime);
      state.velocity = (event.clientY - state.lastY) / elapsed;
      state.lastY = event.clientY;
      state.lastTime = event.timeStamp;
      const distance = event.clientY - state.startY;
      if (Math.abs(distance) > DRAG_SLOP) moved.current = true;
      const { expandable, expanded } = latest.current;
      const follows = distance >= 0 || (expandable && !expanded);
      setOffset(surfaceRef.current, follows ? distance : distance / 4);
    },
    onPointerUp: release,
    onPointerCancel: release,
    /** A press that became a drag must not also activate the grabber. */
    onClickCapture(event: { preventDefault(): void; stopPropagation(): void }) {
      if (!moved.current) return;
      moved.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

/**
 * Keeps an open sheet above the on-screen keyboard: the visual viewport's
 * shortfall from the layout viewport becomes --sheet-keyboard-inset. Listens
 * only while the sheet is open.
 */
export function useKeyboardInset(surfaceRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    const surface = surfaceRef.current;
    if (!active || !viewport || !surface) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      surface.style.setProperty("--sheet-keyboard-inset", `${Math.round(inset)}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      surface.style.removeProperty("--sheet-keyboard-inset");
    };
  }, [active, surfaceRef]);
}
