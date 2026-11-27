import { useEffect, useMemo, useRef } from "react";
import { PanResponder, type GestureResponderEvent } from "react-native";
import { toFrame } from "./geometry";
import type { InputQueue } from "./input";

export function usePagePointer(box: Parameters<typeof toFrame>[1] | null, queue: InputQueue | null) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), [box, queue]);

  return useMemo(() => {
    if (!box || !queue) return {};
    const point = ({ nativeEvent }: GestureResponderEvent) =>
      toFrame({ x: nativeEvent.locationX, y: nativeEvent.locationY }, box);
    let start: ReturnType<typeof point> = null;
    let last: ReturnType<typeof point> = null;
    let mode: "tap" | "scroll" | "drag" = "tap";

    return PanResponder.create({
      onStartShouldSetPanResponder: event => point(event) !== null,
      onPanResponderGrant: event => {
        const origin = point(event);
        if (!origin) return;
        start = last = origin;
        mode = "tap";
        timer.current = setTimeout(() => {
          mode = "drag";
          queue.push({ t: "down", ...origin });
        }, 400);
      },
      onPanResponderMove: (event, gesture) => {
        if (!start || !last) return;
        if (mode === "tap" && Math.hypot(gesture.dx, gesture.dy) > 8) {
          clearTimeout(timer.current);
          mode = "scroll";
        }
        const next = point(event);
        if (!next) return;
        if (mode === "scroll") {
          queue.push({ t: "wheel", ...start, dx: next.x - last.x, dy: next.y - last.y });
        }
        if (mode === "drag") queue.push({ t: "move", ...next });
        last = next;
      },
      onPanResponderRelease: event => {
        clearTimeout(timer.current);
        if (mode === "drag" && last) queue.push({ t: "up", ...(point(event) ?? last) });
        if (mode === "tap" && start) queue.push({ t: "down", ...start }, { t: "up", ...start });
        start = last = null;
      },
      onPanResponderTerminate: () => {
        clearTimeout(timer.current);
        if (mode === "drag" && last) queue.push({ t: "up", ...last });
        start = last = null;
      },
    }).panHandlers;
  }, [box, queue]);
}
