import { Button } from "../../../Button";
import { Input } from "../../../Input";
import { Kbd } from "../../../Kbd";
import { SegmentedControl } from "../../../SegmentedControl";
import { Switch } from "../../../Switch";
import { Annotations } from "../shared/Annotations";
import { openingItems } from "../shared/guides";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import type { Annot, Geometry } from "../shared/types";
import { RING_TOKENS, type FocusCopy } from "./focusCopy";
import s from "./FocusHero.module.css";

/** One ring per control of the tab order; the walk shows one at a time. */
export const RINGS: Annot[] = [0, 1, 2, 3].map((k) => ({ kind: "ring", target: `c${k}` }));

/**
 * The token field: a Tab key cap and its count, a row of real controls in
 * tab order that the one ring walks through (their rings are guides drawn
 * with the live --focus-ring), a width bracket for the close-up, and the
 * focus tokens. The poster rests with the ring on the first control.
 */
export function FocusField({ g, copy }: { g: Geometry | null; copy: FocusCopy }) {
  return (
    <div className={s.field} data-m="field">
      <div className={s.keyRow}>
        <span className={s.stack}>
          <span className={s.layer} data-t="key-tab"><Kbd keys={["Tab"]} /></span>
          <span className={s.layer} data-t="key-back"><Kbd keys={["⇧", "Tab"]} /></span>
        </span>
        <span className={s.stack} data-kind="count">
          {[1, 2, 3, 4].map((n) => <span className={s.layer} data-t={`cnt-${n}`} key={n}>{`${n}/4`}</span>)}
        </span>
      </div>
      <div className={s.row} data-m="tabrow" data-mark-scope="tabrow">
        <span className={s.probe}>
          <Mark n="c0" part><Button text={<R name="c0-t">{copy.continue}</R>} /></Mark>
          <span className={s.posterRing} data-t="pring" />
        </span>
        <Mark n="c1" part><Input aria-label={copy.name} readOnly value={copy.name} /></Mark>
        <Mark n="c2" part><Switch aria-label={copy.sidebar} checked onCheckedChange={() => undefined} /></Mark>
        <Mark n="c3" part>
          <SegmentedControl ariaLabel={copy.week} onValueChange={() => undefined} value="week"
            options={[{ value: "week", label: <R name="c3-a">{copy.week}</R> }, { value: "month", label: <R name="c3-b">{copy.month}</R> }]} />
        </Mark>
        {g ? <Annotations items={openingItems(RINGS, g.scopes.tabrow ?? {}, "r", g.layout)} /> : null}
      </div>
      <div className={s.tokens}>
        {RING_TOKENS.map(([token, value], k) => (
          <div className={s.tokenRow} key={token}>
            <span><R name={`ft-n${k}`}>{token}</R></span>
            <span className={s.tokenValue}><R name={`ft-v${k}`}>{value}</R></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The close-up, in its own scene: the first control with its ring, the ring's
 * 2px width bracketed and its color named beside it.
 */
export function FocusCloseUp({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.closeUp}>
      <span className={s.probe} data-m="closeup">
        <span className={s.closeButton} data-t="cu-b"><Button text={<R name="cu-t">{copy.continue}</R>} /></span>
        <span className={s.closeRing} data-t="cu-r" />
        <span className={s.bracket} data-t="wm" />
        <span className={s.widthNote} data-t="wn"><R name="wn-t">--focus-ring-width 2</R></span>
        <span className={s.colorNote} data-t="cn"><span className={s.swatch} /><R name="cn-t">--focus-ring-color</R></span>
      </span>
    </div>
  );
}
