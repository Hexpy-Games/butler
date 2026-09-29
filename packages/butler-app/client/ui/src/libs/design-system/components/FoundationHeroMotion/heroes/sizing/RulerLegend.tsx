import type { RulerMark } from "./SizingRuler";
import s from "./SizingHero.module.css";

/** Tall: the ruler's tokens with their values, under the window (its lines carry only the values). */
export function RulerLegend({ marks, name }: { marks: RulerMark[]; name?: string }) {
  const unique = marks.filter((mark, k) => marks.findIndex((other) => other.token === mark.token) === k);
  return (
    <span className={s.legend} data-t={name ? `${name}-lg` : undefined}>
      {unique.map((mark) => <span key={mark.token}>{`${mark.token} ${Math.round(mark.height)}`}</span>)}
    </span>
  );
}
