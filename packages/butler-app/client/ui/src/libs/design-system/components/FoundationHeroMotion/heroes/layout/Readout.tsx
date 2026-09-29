import { useLayoutEffect, useRef } from "react";
import { Tag } from "../../../Tag";
import { MODES } from "./layoutCopy";
import s from "./LayoutHero.module.css";

/** The window's width in device px, read from the window itself on every frame of the drag: one tabular number that changes in place. */
function LiveWidth() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    const win = node?.closest("[data-slot=\"foundation-hero\"]")?.querySelector<HTMLElement>("[data-t=\"win\"]");
    if (!node || !win) return undefined;
    const show = () => {
      // The window's box is drawn at --s canvas px per device px (LayoutHero.module.css).
      const scale = Number.parseFloat(getComputedStyle(win.parentElement!).getPropertyValue("--s")) || 1;
      node.textContent = String(Math.round(win.offsetWidth / scale));
    };
    show();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(show) : null;
    observer?.observe(win);
    return () => observer?.disconnect();
  }, []);
  return <span className={s.liveWidth} ref={ref}>1280</span>;
}

/** The width and mode as the handle drags: the width follows the window, the mode cuts at each breakpoint. */
export function Readout({ id, className }: { id: string; className: string }) {
  return (
    <span className={className} data-t={id}>
      <Tag tone="accent"><LiveWidth /> px</Tag>
      <span className={s.modes}>{MODES.map((mode, k) => <span data-t={`${id}-m${k}`} key={mode}><Tag>{mode}</Tag></span>)}</span>
    </span>
  );
}
