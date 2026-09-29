import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { roundedWithin } from "../shared/measure";
import { Reveal as R } from "../shared/Reveal";
import s from "./RadiusHero.module.css";

/** Stroke of a corner arc (canvas px): its outer edge lies on the component's outer edge. */
const STROKE = 2.5;

interface Corner { x: number; y: number; r: number }

/** The component's rounded box inside `host`, in the host's own (untransformed) px, and its real top-left radius. */
function cornerOf(host: HTMLElement): Corner | null {
  const first = host.firstElementChild;
  if (!(first instanceof HTMLElement)) return null;
  const target = roundedWithin(first);
  const outer = host.getBoundingClientRect();
  const scale = outer.width / Math.max(1, host.offsetWidth);
  if (!scale) return null;
  const box = target.getBoundingClientRect();
  const w = box.width / scale;
  const h = box.height / scale;
  const r = Math.min(Number.parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0, w / 2, h / 2);
  return { x: (box.left - outer.left) / scale, y: (box.top - outer.top) / scale, r };
}

/**
 * A real component with its top-left corner measured: its value set above
 * (the radius it really renders, or `value`), and a quarter arc drawn on the
 * corner itself, clockwise from the side to the top (`wa-<n>` draws it by
 * dash). The arc lies on the outline, never over the content. Renders two
 * grid items (the value, then the component) for the row's shared value line.
 */
export function Worn({ n, value, children }: { n: string; value?: string; children: ReactNode }) {
  const host = useRef<HTMLSpanElement>(null);
  const [corner, setCorner] = useState<Corner | null>(null);
  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return undefined;
    const measure = () => {
      const next = cornerOf(node);
      setCorner((last) => (next && (!last || Math.abs(last.x - next.x) + Math.abs(last.y - next.y) + Math.abs(last.r - next.r) > 0.1) ? next : last));
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);
  const r = corner?.r ?? 0;
  const a = r - STROKE / 2;
  return (
    <>
      <span className={s.wornValue}><R name={`wv-${n}`}>{value ?? String(Math.round(r))}</R></span>
      <span className={s.wornHost} ref={host}>
        {children}
        {corner && r > STROKE ? (
          <svg className={s.wornArc} height={r} style={{ left: corner.x, top: corner.y }} viewBox={`0 0 ${r} ${r}`} width={r}>
            <path d={`M ${STROKE / 2} ${r} A ${a} ${a} 0 0 1 ${r} ${STROKE / 2}`} data-t={`wa-${n}`} pathLength={100} />
          </svg>
        ) : null}
      </span>
    </>
  );
}
