import { Button } from "../../../Button";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import type { FocusCopy } from "./focusCopy";
import { RANGE, Ring } from "./FocusScenes";
import { Keys } from "./Keys";
import { Range } from "./Range";
import s from "./FocusHero.module.css";

/** Scene 5: a group is one Tab stop; arrows move inside it (the selection follows); Tab leaves to the next control. */
export function GroupScene({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.groupStage} data-m="group">
      <div className={s.groupFrame} data-mark-scope="group">
        <span className={s.stacked}>
          {RANGE.map((id, k) => <span data-t={`gv-${k}`} key={id}><Range copy={copy} named={k === 0} value={id} /></span>)}
        </span>
        <Mark n="apply"><Button text={copy.apply} /></Mark>
        <Ring name="gr" />
      </div>
      <span className={s.caption}><R name="rv">{copy.roving}</R></span>
      <Keys keys={["tab", "right"]} prefix="gk" />
    </div>
  );
}
