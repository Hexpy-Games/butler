import { type CSSProperties } from "react";
import type { RulerMark } from "./SizingRuler";
import s from "./SizingHero.module.css";

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
