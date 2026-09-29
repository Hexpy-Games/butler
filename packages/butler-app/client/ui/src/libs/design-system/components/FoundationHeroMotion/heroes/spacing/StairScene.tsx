import { Reveal as R } from "../shared/Reveal";
import { Roller } from "../shared/Roller";
import { STEPS, UNIT, type SpacingCopy } from "./spacingCopy";
import { count } from "./spacingCount";
import { Staircase } from "./Staircase";
import s from "./SpacingHero.module.css";

/** The last value first, so the poster rests on it; each value cuts in (left aligned, no padding). */
function Cut({ id, values }: { id: string; values: string[] }) {
  return (
    <span className={s.cut}>
      {values.map((value, k) => <span data-last={k === values.length - 1 ? "" : undefined} data-t={`${id}-${k}`} key={value}>{value}</span>)}
    </span>
  );
}

/**
 * Scene 2: one 4px unit, drawn large and named; it shrinks into the xs slot
 * and the named steps build from it, each with its size; the readout counts
 * `px = n×4`.
 */
export function StairScene({ copy }: { copy: SpacingCopy }) {
  const last = STEPS.length - 1;
  return (
    <div className={s.stairStage} data-m="stairs">
      <Staircase name="st" unit={<span className={s.unit} data-m="unit" data-t="unit" />} />
      <div className={s.readout} data-t="st-read">
        <span className={s.readToken}>--space-<Cut id="sts" values={STEPS.map(([name]) => name)} /></span>
        <span className={s.readLine}>
          <Roller className={s.bigValue} id="stp" poster={last} values={STEPS.map(([, px]) => String(px))} />
          <span className={s.readUnit}>px</span>
        </span>
        <span className={s.readLine}>
          <Roller className={s.midValue} id="stn" poster={last} values={STEPS.map(([, px]) => String(count(px)))} />
          <span className={s.readUnit}>{`× ${UNIT}px`}</span>
        </span>
      </div>
      <span className={s.unitLabel} data-t="unit-l">
        <span className={s.unitName}><R name="unit-t">{copy.unit}</R></span>
        <span className={s.readToken}><R name="unit-k">--space-xs</R></span>
      </span>
    </div>
  );
}
