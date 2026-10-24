import { useEffect, useState } from "react";
import type { WallpaperContentRect } from "@/butler-ds";
import { waitForAncestorMotion } from "./ancestorMotion.ts";

/**
 * An element's client rect in CSS px (a Wallpaper `contentRect`), kept
 * current through resizes and scrolling, measured at most once a frame.
 * Undefined without an element. Equal measurements keep one object.
 * `settleMotion`: while an ancestor runs a finite animation (an inspector
 * track sliding open moves the element every frame), later changes wait
 * and commit once, where the motion ends.
 */
export function useElementClientRect(element: Element | null, { settleMotion = false } = {}): WallpaperContentRect | undefined {
  const [rect, setRect] = useState<WallpaperContentRect | undefined>(undefined);
  useEffect(() => {
    if (!element) {
      setRect(undefined);
      return undefined;
    }
    let frame = 0;
    let settling = false;
    let disposed = false;
    const commit = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      setRect((current) => current && current.x === x && current.y === y && current.width === width && current.height === height
        ? current
        : { x, y, width, height });
    };
    const schedule = () => {
      if (!frame && !settling) frame = window.requestAnimationFrame(measure);
    };
    // A reversed motion replaces the animation: the next measure waits for that one.
    const settled = () => {
      settling = false;
      if (!disposed) schedule();
    };
    const measure = () => {
      frame = 0;
      settling = settleMotion && waitForAncestorMotion(element, settled);
      if (!settling) commit();
    };
    commit();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    // Scroll does not bubble; capturing on the document sees every scroller.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
    };
  }, [element, settleMotion]);
  return rect;
}
