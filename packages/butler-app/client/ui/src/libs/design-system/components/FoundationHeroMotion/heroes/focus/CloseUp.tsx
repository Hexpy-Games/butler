import { Button } from "../../../Button";
import { Reveal as R } from "../shared/Reveal";
import type { FocusCopy } from "./focusCopy";
import s from "./FocusHero.module.css";

/** Scene 3: close on one ring: two pixels, the accent colour, the control's own corner. */
export function CloseUp({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.closeStage}>
      <span className={s.closeTarget} data-m="closeup">
        <span className={s.ringOn}><Button text={copy.continue} /></span>
        <span className={s.note} data-place="top" data-t="cn-w"><R name="cn-w-t">--focus-ring-width 2</R></span>
        <span className={s.note} data-place="bottom" data-t="cn-c"><span className={s.swatch} /><R name="cn-c-t">--focus-ring-color</R></span>
      </span>
    </div>
  );
}
