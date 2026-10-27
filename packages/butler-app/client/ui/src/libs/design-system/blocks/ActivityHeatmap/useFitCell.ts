import { useCallback, useRef, useState } from "react";

/**
 * Under a larger App text size (page zoom, `--ui-scale`), the cell size that
 * shows every week without scrolling: the CSS base size (`--heatmap-cell-base`)
 * or smaller, but never below the base's on-screen size at 100%
 * (base / --ui-scale). At 100% cells never shrink; past the floor the
 * scroller scrolls as it always has.
 */
export function useFitCell(weeks: number) {
  const [fit, setFit] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const measure = () => {
      const style = getComputedStyle(node);
      const base = parseFloat(style.getPropertyValue("--heatmap-cell-base"));
      const min = base / (parseFloat(style.getPropertyValue("--ui-scale")) || 1);
      const gap = parseFloat(style.getPropertyValue("--heatmap-gap")) || 0;
      const inner = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (!Number.isFinite(base) || !Number.isFinite(min) || inner <= 0) return;
      const size = Math.max(min, Math.min(base, Math.floor((inner - (weeks - 1) * gap) / weeks)));
      setFit(size === base ? null : size);
    };
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
    measure();
  }, [weeks]);
  return [fit, ref] as const;
}
