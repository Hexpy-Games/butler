import { useEffect, useMemo, useRef } from "react";
import { PanResponder, type GestureResponderEvent } from "react-native";
import { toFrame } from "./geometry";
import type { InputQueue } from "./input";

export function usePagePointer(box: Parameters<typeof toFrame>[1] | null, queue: InputQueue | null) {
  const boxRef = useRef(box);
  boxRef.current = box;
  const pointer = useRef<{
    start: ReturnType<typeof toFrame>;
    last: ReturnType<typeof toFrame>;
    mode: "tap" | "scroll" | "drag";
  }>({ start: null, last: null, mode: "tap" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const handlers = useMemo(() => {
    if (!queue) return;
    const point = ({ nativeEvent }: GestureResponderEvent) => {
      const currentBox = boxRef.current;
      return currentBox ? toFrame({ x: nativeEvent.locationX, y: nativeEvent.locationY }, currentBox) : null;
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: event => point(event) !== null,
      onPanResponderGrant: event => {
        const origin = point(event);
        if (!origin) return;
        pointer.current.start = pointer.current.last = origin;
        pointer.current.mode = "tap";
        timer.current = setTimeout(() => {
          pointer.current.mode = "drag";
          queue.push({ t: "down", ...origin });
        }, 400);
      },
      onPanResponderMove: (event, gesture) => {
        const { start, last } = pointer.current;
        if (!start || !last) return;
        if (pointer.current.mode === "tap" && Math.hypot(gesture.dx, gesture.dy) > 8) {
          clearTimeout(timer.current);
          pointer.current.mode = "scroll";
        }
        const next = point(event);
        if (!next) return;
        if (pointer.current.mode === "scroll") {
          queue.push({ t: "wheel", ...start, dx: next.x - last.x, dy: next.y - last.y });
        }
        if (pointer.current.mode === "drag") queue.push({ t: "move", ...next });
        pointer.current.last = next;
      },
      onPanResponderRelease: event => {
        clearTimeout(timer.current);
        const { start, last, mode } = pointer.current;
        if (mode === "drag" && last) queue.push({ t: "up", ...(point(event) ?? last) });
        if (mode === "tap" && start) queue.push({ t: "down", ...start }, { t: "up", ...start });
        pointer.current.start = pointer.current.last = null;
      },
      onPanResponderTerminate: () => {
        clearTimeout(timer.current);
        const { last, mode } = pointer.current;
        if (mode === "drag" && last) queue.push({ t: "up", ...last });
        pointer.current.start = pointer.current.last = null;
      },
    }).panHandlers;
  }, [queue]);

  return !queue || !box ? {} : handlers;
}
