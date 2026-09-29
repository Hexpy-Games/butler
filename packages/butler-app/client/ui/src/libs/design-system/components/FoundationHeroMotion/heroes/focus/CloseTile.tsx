import { Button } from "../../../Button";
import type { FocusCopy } from "./focusCopy";
import s from "./FocusHero.module.css";

/** Finale: the ring close-up (the notes in flow, so the tile's padding always holds them). */
export function CloseTile({ copy }: { copy: FocusCopy }) {
  return (
    <span className={s.closeTile} data-still="">
      <span className={s.noteFlow}>--focus-ring-width 2</span>
      <span className={s.ringOn}><Button text={copy.continue} /></span>
      <span className={s.noteFlow}><span className={s.swatch} />--focus-ring-color</span>
    </span>
  );
}
