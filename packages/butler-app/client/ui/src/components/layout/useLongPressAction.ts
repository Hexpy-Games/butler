import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent, PointerEvent } from "react";

export const LONG_PRESS_DURATION_MS = 500;
export const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

export function useLongPressAction(onLongPress: () => void) {
  const timerRef = useRef<number | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const completedRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    originRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!event.isPrimary || !["touch", "pen"].includes(event.pointerType)) {
        return;
      }
      cancel();
      completedRef.current = false;
      originRef.current = { x: event.clientX, y: event.clientY };
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        completedRef.current = true;
        onLongPress();
      }, LONG_PRESS_DURATION_MS);
    },
    [cancel, onLongPress],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const origin = originRef.current;
      if (
        origin &&
        Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >
          LONG_PRESS_MOVE_TOLERANCE_PX
      ) {
        cancel();
      }
    },
    [cancel],
  );

  const onClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!completedRef.current) return;
    completedRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return {
    onClickCapture,
    onPointerCancel: cancel,
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
  };
}
