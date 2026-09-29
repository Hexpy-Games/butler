import { useLayoutEffect, useState, type RefObject } from "react";
import { CANVAS, TALL_BELOW, type HeroLayout } from "./grid";

/** Layout (wide or tall canvas) and fit scale of a feature hero's canvas in its stage: contained, or covering it (edges cropped). */
export function useFrame(root: RefObject<HTMLElement | null>, cover = false) {
  const [frame, setFrame] = useState<{ layout: HeroLayout; fit: number }>({ layout: "wide", fit: 1 });
  useLayoutEffect(() => {
    const stage = root.current?.parentElement;
    if (!stage) return undefined;
    const update = () => {
      const layout: HeroLayout = stage.clientWidth < TALL_BELOW ? "tall" : "wide";
      const canvas = CANVAS[layout];
      const pick = cover ? Math.max : Math.min;
      const fit = Math.round(pick(stage.clientWidth / canvas.w, stage.clientHeight / canvas.h) * 1000) / 1000 || 1;
      setFrame((current) => (current.layout === layout && current.fit === fit ? current : { layout, fit }));
    };
    update();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [root, cover]);
  return frame;
}
