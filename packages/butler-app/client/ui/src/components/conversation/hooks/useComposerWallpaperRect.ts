import { useEffect, type RefObject } from "react";
import type { WallpaperContentRect } from "@/butler-ds";
import { waitForAncestorMotion } from "@/hooks/ancestorMotion";

/** Change-driven composer keep-out, including layout motion; no scroll listener or idle polling. */
export function useComposerWallpaperRect(ref: RefObject<HTMLDivElement | null>, onRect?: (rect: WallpaperContentRect) => void) {
  useEffect(() => {
    const wrap = ref.current;
    const element = wrap?.querySelector('[data-test-class~="composer-card"]');
    if (!element || !onRect) return;
    let last: WallpaperContentRect | undefined;
    let disposed = false;
    let settling = false;
    const measure = () => {
      if (disposed) return;
      if (!settling) settling = waitForAncestorMotion(element, () => {
        settling = false;
        measure();
      });
      const { x, y, width, height } = element.getBoundingClientRect();
      if (last?.x === x && last.y === y && last.width === width && last.height === height) return;
      last = { x, y, width, height };
      onRect(last);
    };
    const observer = new ResizeObserver(measure);
    const shell = wrap?.closest('[data-test-class~="conversation"]');
    for (let container: Element | null = element; container; container = container.parentElement) {
      observer.observe(container);
      if (container === shell) break;
    }
    // Layout attributes can move a fixed-width composer without resizing it.
    const layout = new MutationObserver(measure);
    if (shell) layout.observe(shell, { attributes: true });
    window.addEventListener("resize", measure);
    measure();
    return () => {
      disposed = true;
      observer.disconnect();
      layout.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref, onRect]);
}
