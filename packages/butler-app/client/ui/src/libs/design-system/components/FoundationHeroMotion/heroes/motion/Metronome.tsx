import { useLayoutEffect, useRef } from "react";
import { CANVAS } from "../shared/grid";
import { TICKS } from "./motionLanes";
import s from "./MotionHero.module.css";

/**
 * The metronome along the frame's bottom edge: a tick every beat, a taller
 * one on each bar, and a cursor the timeline steps onto the next tick every
 * beat, all chapter long and through the finale. The stage covers its frame
 * (a wide frame crops the canvas top and bottom), so the track keeps to the
 * visible bottom edge: it rises by the crop.
 */
export function Metronome() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const board = node?.closest<HTMLElement>("[data-hero-scope]");
    const stage = board?.parentElement;
    if (!node || !board || !stage) return undefined;
    const update = () => {
      const fit = Number.parseFloat(board.style.getPropertyValue("--fit")) || 1;
      const height = CANVAS[board.dataset.layout === "tall" ? "tall" : "wide"].h;
      node.style.setProperty("--crop", `${Math.max(0, (height * fit - stage.clientHeight) / 2 / fit)}px`);
    };
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(stage);
    return () => observer?.disconnect();
  }, []);
  return (
    <div className={s.metro} aria-hidden="true" ref={ref}>
      {Array.from({ length: TICKS }, (_, k) => <span className={s.tick} data-down={k % 4 === 0 ? "" : undefined} key={k} />)}
      <span className={s.cursor} data-t="metro" />
    </div>
  );
}
