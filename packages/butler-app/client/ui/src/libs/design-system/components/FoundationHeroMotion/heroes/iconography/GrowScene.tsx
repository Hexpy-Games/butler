import { Settings } from "../../../Icons";
import { Roller } from "../shared/Roller";
import { STEPS, type IconCopy } from "./iconCopy";
import { roleText } from "./iconParts";
import s from "./IconHero.module.css";

/**
 * Scene 3 (signature): one label row steps through five roles; the icon
 * swaps its named size in lockstep on a centre line that never moves. The
 * readouts (role, size token, px) stand beside the row (below it on the
 * phone), clear of the widest step.
 */
export function GrowScene({ copy }: { copy: IconCopy }) {
  const last = STEPS.length - 1;
  return (
    <div className={s.growStage} data-m="grow">
      <span className={s.growRow}>
        <span className={s.growLine} data-t="gr-line" />
        <span className={s.layers}>{STEPS.map((step, k) => <span className={s.layer} data-t={`gi-${k}`} key={step.icon}><Settings size={step.icon} /></span>)}</span>
        <span className={s.layers}>{STEPS.map((step, k) => <span className={s.layer} data-t={`gt-${k}`} key={step.role}>{roleText(step.role, copy.settings)}</span>)}</span>
      </span>
      <span className={s.growRead}>
        <Cuts className={s.readRole} name="grr" values={STEPS.map((step) => step.role)} />
        <Cuts className={s.readToken} name="grn" values={STEPS.map((step) => `--icon-size-${step.icon}`)} />
        <Roller className={s.bigValue} id="grp" poster={last} values={STEPS.map((step) => String(step.px))} />
      </span>
    </div>
  );
}

/** A readout that cuts between its values in place, left-aligned (the timeline shows one at a time). */
function Cuts({ name, values, className }: { name: string; values: string[]; className?: string }) {
  return <span className={`${s.cuts} ${className ?? ""}`}>{values.map((value, k) => <span className={s.cutLayer} data-t={`${name}-${k}`} key={value}>{value}</span>)}</span>;
}
