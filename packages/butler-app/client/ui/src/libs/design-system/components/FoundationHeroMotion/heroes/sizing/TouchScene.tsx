import { Roller } from "../shared/Roller";
import { HIT, type SizingCopy } from "./sizingCopy";
import { TouchBar } from "./TouchBar";
import s from "./SizingHero.module.css";

/** Scene 3 (signature): the real titlebar; the pointer's 30 targets; the cursor becomes a finger and every target grows to 44, the buttons moving apart. */
export function TouchScene({ copy }: { copy: SizingCopy }) {
  return (
    <div className={s.touchStage} data-m="touch">
      <TouchBar copy={copy} name="tc" pointer />
      <span className={s.readout} data-t="tc-read">
        <Roller className={s.bigValue} id="tcv" poster={1} values={[String(HIT.pointer), String(HIT.touch)]} />
        <span className={s.readToken}>--control-hit-target</span>
        <span className={s.modes}>
          <span className={s.mode} data-t="tc-m0">{copy.pointer}</span>
          <span className={s.mode} data-t="tc-m1">{copy.touch}</span>
        </span>
      </span>
    </div>
  );
}
