import { Button } from "../../../Button";
import { Input } from "../../../Input";
import { SegmentedControl } from "../../../SegmentedControl";
import { Switch } from "../../../Switch";
import { Mark } from "../shared/Mark";
import type { FocusCopy } from "./focusCopy";
import { Named } from "./Named";
import { Ring } from "./FocusScenes";
import { Keys } from "./Keys";
import s from "./FocusHero.module.css";

const SEGMENT = { c3: '[role="radio"][data-state="on"]' };

/** Scene 2: one ring: Tab walks a short row of real controls; the ring takes each one's corner. */
export function RowScene({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.rowStage} data-m="row">
      <div className={s.row} data-mark-scope="row">
        <Mark n="c0"><Button text={copy.continue} /></Mark>
        <Mark n="c1"><Input aria-label={copy.name} readOnly value={copy.name} /></Mark>
        <Mark n="c2"><Switch aria-label={copy.autoSave} checked onCheckedChange={() => undefined} /></Mark>
        <Named names={SEGMENT}>
          <SegmentedControl ariaLabel={copy.week} onValueChange={() => undefined} value="week" options={[{ value: "week", label: copy.week }, { value: "month", label: copy.month }]} />
        </Named>
        <Ring name="rr" />
      </div>
      <Keys keys={["tab"]} prefix="rk" />
    </div>
  );
}
