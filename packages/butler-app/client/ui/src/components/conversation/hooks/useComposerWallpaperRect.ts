import { useEffect, type RefObject } from "react";
import type { WallpaperContentRect } from "@/butler-ds";

/** Composer keep-out: resize-driven, with no scroll listener or idle polling. */
export function useComposerWallpaperRect(ref: RefObject<HTMLDivElement | null>, onRect?: (rect: WallpaperContentRect) => void) {
  useEffect(() => {
    const wrap = ref.current;
    const element = wrap?.querySelector('[data-test-class~="composer-card"]');
    if (!element || !onRect) return;
    let last: WallpaperContentRect | undefined;
    const measure = () => {
      const { x, y, width, height } = element.getBoundingClientRect();
      if (last?.x === x && last.y === y && last.width === width && last.height === height) return;
      last = { x, y, width, height };
      onRect(last);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const shell = wrap?.closest('[data-test-class~="conversation"]');
    if (shell) observer.observe(shell);
    window.addEventListener("resize", measure);
    measure();
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [ref, onRect]);
}
