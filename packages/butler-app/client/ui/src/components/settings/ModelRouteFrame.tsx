import { useEffect, useRef, type ReactNode } from "react";
import { animateMotion, motionDistance } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";

interface ModelRouteFrameProps {
  title: string;
  children: ReactNode;
}

export function ModelRouteFrame({ title, children }: ModelRouteFrameProps) {
  const direction = useSettingsUIStore((state) => state.modelRouteDirection);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const travel = motionDistance("lg") * (direction === "forward" ? 1 : -1);
    animateMotion(element, [
      { opacity: 0, transform: `translateX(${travel}px)` },
      { opacity: 1, transform: "translateX(0)" },
    ], { duration: "base", easing: "decelerate" });
  }, [direction, title]);

  return (
    <div ref={ref} data-direction={direction}>
      {children}
    </div>
  );
}
