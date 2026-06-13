import { useEffect, useRef, type ReactNode } from "react";
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
    if (!element || typeof element.animate !== "function") return;
    element.animate([
      {
        opacity: 0,
        transform: `translateX(${direction === "forward" ? 28 : -28}px)`,
      },
      { opacity: 1, transform: "translateX(0)" },
    ], {
      duration: 180,
      easing: "ease-out",
    });
  }, [direction, title]);

  return (
    <div ref={ref} data-direction={direction}>
      {children}
    </div>
  );
}
