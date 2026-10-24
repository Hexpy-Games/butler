import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** Zoom in/out buttons and +/- keys step by this factor. */
export const ZOOM_STEP = 1.5;
/** Double-click or double-tap zooms to this level at the point (or back to fit). */
const DOUBLE_TAP_ZOOM = 2;

export type ZoomView = { scale: number; x: number; y: number };
const FIT: ZoomView = { scale: 1, x: 0, y: 0 };

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Keeps the zoomed picture covering its fitted box: no panning past its edges. */
export function clampView(view: ZoomView, width: number, height: number): ZoomView {
  const scale = clamp(view.scale, MIN_ZOOM, MAX_ZOOM);
  if (scale === 1) return FIT;
  const maxX = ((scale - 1) * width) / 2;
  const maxY = ((scale - 1) * height) / 2;
  return { scale, x: clamp(view.x, -maxX, maxX), y: clamp(view.y, -maxY, maxY) };
}

/** Zooms to `scale` keeping the point (offset from the picture's centre, in screen px) still. */
export function zoomAt(view: ZoomView, scale: number, pointX: number, pointY: number): ZoomView {
  const ratio = scale / view.scale;
  return { scale, x: pointX - (pointX - view.x) * ratio, y: pointY - (pointY - view.y) * ratio };
}

type Gesture = { pointers: Map<number, { x: number; y: number }>; startDistance: number; startScale: number };

/**
 * Zoom and pan for one picture: double-click/tap toggles 2x at the point, pinch and ctrl/cmd + wheel
 * (trackpad pinch) zoom around the fingers or cursor, a drag pans while zoomed. Returns the view for
 * a CSS transform plus handlers. A new `picture` (its src) starts back at fit.
 */
export function useZoomPan(enabled: boolean, picture: string) {
  const targetRef = useRef<HTMLElement | null>(null);
  const [view, setView] = useState<ZoomView>(FIT);
  const gesture = useRef<Gesture>({ pointers: new Map(), startDistance: 0, startScale: 1 });

  const apply = useCallback((next: (view: ZoomView) => ZoomView) => {
    const target = targetRef.current;
    if (!target) return;
    setView((current) => clampView(next(current), target.offsetWidth, target.offsetHeight));
  }, []);

  /** Offset of a client point from the picture's fitted centre. */
  const fromCentre = useCallback((clientX: number, clientY: number, current: ZoomView) => {
    const rect = targetRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - (rect.left + rect.width / 2 - current.x), y: clientY - (rect.top + rect.height / 2 - current.y) };
  }, []);

  const zoomBy = useCallback((factor: number) => {
    apply((current) => zoomAt(current, clamp(current.scale * factor, MIN_ZOOM, MAX_ZOOM), 0, 0));
  }, [apply]);
  const reset = useCallback(() => setView(FIT), []);
  useEffect(() => {
    setView(FIT);
    gesture.current.pointers.clear();
  }, [picture]);

  // Trackpad pinch arrives as a ctrl+wheel; it must be non-passive to stop the page zooming.
  useEffect(() => {
    const target = targetRef.current;
    if (!enabled || !target) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      apply((current) => {
        const point = fromCentre(event.clientX, event.clientY, current);
        return zoomAt(current, clamp(current.scale * Math.exp(-event.deltaY * 0.01), MIN_ZOOM, MAX_ZOOM), point.x, point.y);
      });
    };
    target.addEventListener("wheel", wheel, { passive: false });
    return () => target.removeEventListener("wheel", wheel);
  }, [apply, enabled, fromCentre, picture]);

  const handlers = {
    onDoubleClick(event: { clientX: number; clientY: number }) {
      apply((current) => {
        if (current.scale > 1) return FIT;
        const point = fromCentre(event.clientX, event.clientY, current);
        return zoomAt(current, DOUBLE_TAP_ZOOM, point.x, point.y);
      });
    },
    onPointerDown(event: PointerEvent<HTMLElement>) {
      const { pointers } = gesture.current;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1 && view.scale === 1) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture.current.startDistance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        gesture.current.startScale = view.scale;
      }
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const { pointers } = gesture.current;
      const last = pointers.get(event.pointerId);
      if (!last) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const scale = clamp(gesture.current.startScale * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.current.startDistance), MIN_ZOOM, MAX_ZOOM);
        apply((current) => {
          const point = fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2, current);
          return zoomAt(current, scale, point.x, point.y);
        });
      } else if (pointers.size === 1) {
        const dx = event.clientX - last.x;
        const dy = event.clientY - last.y;
        apply((current) => (current.scale > 1 ? { ...current, x: current.x + dx, y: current.y + dy } : current));
      }
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      gesture.current.pointers.delete(event.pointerId);
    },
    onPointerCancel(event: PointerEvent<HTMLElement>) {
      gesture.current.pointers.delete(event.pointerId);
    },
  };

  return { targetRef, view, zoomBy, reset, handlers: enabled ? handlers : undefined };
}
