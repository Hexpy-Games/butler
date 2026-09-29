import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import type { FocusCopy } from "./focusCopy";
import s from "./FocusHero.module.css";

/**
 * The title's touch: each word is a stop with room for the ring inside the
 * title's box (the descender and the ring's two pixels included), and one
 * ring moves from "Focus" to "ring".
 */
export function TitleWords({ copy }: { copy: FocusCopy }) {
  return (
    <span className={s.titleWords} data-mark-scope="title">
      <Mark n="w0"><span className={s.word}><R name="i-t0">{copy.title}</R></span></Mark>
      <Mark n="w1"><span className={s.word}><R name="i-t1">{copy.title2}</R></span></Mark>
      <span className={s.ring} data-t="tr" />
    </span>
  );
}
