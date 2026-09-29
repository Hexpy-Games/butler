import { Reveal as R } from "../shared/Reveal";
import { sum } from "./spacingCount";
import s from "./SpacingHero.module.css";

/** A gap's label: its count, then (wide canvas only) its token or a note; revealed as `reveal`. */
export function GapLabel({ px, note, reveal }: { px: number; note?: string; reveal: string }) {
  return (
    <R name={reveal}>
      <span className={s.sum}>{sum(px)}</span>
      {note ? <span className={s.note}>{` · ${note}`}</span> : null}
    </R>
  );
}
