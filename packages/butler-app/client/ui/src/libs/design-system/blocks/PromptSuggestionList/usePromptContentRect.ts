import { useEffect, useState } from "react";
import type { WallpaperContentRect } from "../Wallpaper";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function box(element: Element): Box {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
}

/** The header and the cards as the rail shows them (clipped to its viewport), as one client rect. */
function measure(header: Element, rail: Element, grid: Element): WallpaperContentRect | undefined {
  const clip = box(rail);
  const boxes = [box(header), ...Array.from(grid.children, (card) => {
    const edges = box(card);
    return { left: Math.max(edges.left, clip.left), top: Math.max(edges.top, clip.top), right: Math.min(edges.right, clip.right), bottom: Math.min(edges.bottom, clip.bottom) };
  })].filter((edges) => edges.right > edges.left && edges.bottom > edges.top);
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map((edges) => edges.left));
  const top = Math.min(...boxes.map((edges) => edges.top));
  return { x: left, y: top, width: Math.max(...boxes.map((edges) => edges.right)) - left, height: Math.max(...boxes.map((edges) => edges.bottom)) - top };
}

/**
 * The new-chat text a wallpaper keeps readable (its `contentRect`): the
 * header plus the visible suggestion cards, in client CSS px, kept current
 * through resizes and rail scrolling at most once a frame. Equal measurements
 * keep one object.
 */
export function usePromptContentRect(header: Element | null, rail: Element | null, grid: Element | null): WallpaperContentRect | undefined {
  const [rect, setRect] = useState<WallpaperContentRect | undefined>(undefined);
  useEffect(() => {
    if (!header || !rail || !grid) {
      setRect(undefined);
      return undefined;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = measure(header, rail, grid);
      setRect((current) => current && next && current.x === next.x && current.y === next.y && current.width === next.width && current.height === next.height
        ? current
        : next);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    const observer = new ResizeObserver(schedule);
    for (const element of [header, rail, grid]) observer.observe(element);
    window.addEventListener("resize", schedule);
    // Scroll does not bubble; capturing on the document sees the rail's.
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
    };
  }, [header, rail, grid]);
  return rect;
}
