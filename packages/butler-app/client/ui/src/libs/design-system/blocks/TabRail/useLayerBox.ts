import { useLayoutEffect, useState } from "react";

/** The element's content box, measured before paint and on every resize; null until measured. */
export function useLayerBox(element: HTMLElement | null): { width: number; height: number } | null {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!element) return undefined;
    const update = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setBox((current) => (current && current.width === width && current.height === height ? current : { width, height }));
    };
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return box;
}
