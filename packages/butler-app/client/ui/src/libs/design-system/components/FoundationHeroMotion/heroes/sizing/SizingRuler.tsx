import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import s from "./SizingHero.module.css";

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

/** Dimension lines on the outer left edge of the host, each labelled with its token and live height (the value only when tall). */
export function Ruler({ marks, name }: { marks: RulerMark[]; name?: string }) {
  return (
    <span aria-hidden="true" className={s.ruler}>
      {marks.map((mark, k) => (
        <span className={s.dim} data-t={name ? `${name}-d${k}` : undefined} key={k} style={{ "--top": `${mark.top}px`, "--size": `${mark.height}px` } as CSSProperties}>
          <span className={s.dimLabel}><span className={s.dimToken}>{mark.token}</span> <span>{Math.round(mark.height)}</span></span>
        </span>
      ))}
    </span>
  );
}

/** Tall: the ruler's tokens with their values, under the window (its lines carry only the values). */
export function RulerLegend({ marks, name }: { marks: RulerMark[]; name?: string }) {
  const unique = marks.filter((mark, k) => marks.findIndex((other) => other.token === mark.token) === k);
  return (
    <span className={s.legend} data-t={name ? `${name}-lg` : undefined}>
      {unique.map((mark) => <span key={mark.token}>{`${mark.token} ${Math.round(mark.height)}`}</span>)}
    </span>
  );
}
