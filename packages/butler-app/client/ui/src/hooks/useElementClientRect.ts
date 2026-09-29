import { useEffect, useState } from "react";
import type { WallpaperContentRect } from "@/butler-ds";

/**
 * An element's client rect in CSS px (a Wallpaper `contentRect`), kept
 * current through resizes and scrolling, measured at most once a frame.
 * Undefined without an element. Equal measurements keep one object.
 */
export function useElementClientRect(element: Element | null): WallpaperContentRect | undefined {
  const [rect, setRect] = useState<WallpaperContentRect | undefined>(undefined);
  useEffect(() => {
    if (!element) {
      setRect(undefined);
      return undefined;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const { x, y, width, height } = element.getBoundingClientRect();
      setRect((current) => current && current.x === x && current.y === y && current.width === width && current.height === height
        ? current
        : { x, y, width, height });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    // Scroll does not bubble; capturing on the document sees every scroller.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
    };
  }, [element]);
  return rect;
}
