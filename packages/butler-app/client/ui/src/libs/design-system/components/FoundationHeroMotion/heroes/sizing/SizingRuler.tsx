import { useLayoutEffect, useState, type RefObject } from "react";

export interface RulerMark { token: string; top: number; height: number }

/**
 * The `[data-dim]` elements inside `host`: each one's token, top and live
 * height, in the host's own px (the camera's scale and the poster's zoom
 * divide out).
 */
export function useRulerMarks(host: RefObject<HTMLElement | null>): RulerMark[] {
  const [marks, setMarks] = useState<RulerMark[]>([]);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const scale = box.height / (el.offsetHeight || 1) || 1;
      setMarks([...el.querySelectorAll<HTMLElement>("[data-dim]")].map((dim) => ({
        token: dim.dataset.dim ?? "",
        top: (dim.getBoundingClientRect().top - box.top) / scale,
        height: dim.offsetHeight,
      })));
    };
    measure();
    void document.fonts?.ready.then(measure);
  }, [host]);
  return marks;
}
