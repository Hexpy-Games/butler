import type { CSSProperties } from "react";
import { Notice } from "../../../../blocks/Notice";
import { motionDuration, motionEasing, type MotionEasingName } from "../../../../lib/motion";
import { CheckCircle2 } from "../../../Icons";
import { easingPath } from "../../easingPath";
import { Reveal as R } from "../shared/Reveal";
import { DURATIONS, EASES, PLOT, type MotionCopy } from "./motionCopy";
import s from "./MotionHero.module.css";

/** Bar length (poster px) per millisecond. */
const PX_PER_MS = 0.45;

/**
 * One easing token plotted from its live value on time and value axes: the
 * curve draws along its length (`<id>-c`), a dot runs it (`<id>-x` moves in
 * time, `<id>-y` on the token itself).
 */
export function Plot({ id, ease, size = PLOT }: { id: string; ease: MotionEasingName; size?: number }) {
  return (
    <span className={s.plotBox} style={{ "--plot": `${size}px` } as CSSProperties}>
      <svg className={s.plotSvg} viewBox="0 0 100 100">
        <path className={s.axis} d="M0 0V100H100" />
        <path className={s.curve} d={easingPath(motionEasing(ease)) ?? "M0 100L100 0"} data-t={`${id}-c`} />
      </svg>
      <span className={s.dotX} data-t={`${id}-x`}><span className={s.dot} data-t={`${id}-y`} /></span>
    </span>
  );
}

/**
 * The token field: the five easing curves drawn from their live values,
 * each with a dot running it, and the durations as bars proportional to
 * their milliseconds, each exit beside its entrance.
 */
export function MotionField() {
  return (
    <div className={s.field} data-m="field">
      <span className={s.caption}><R name="mf-cap">--motion-ease-*</R></span>
      <div className={s.plots}>
        {EASES.map((ease, k) => (
          <div className={s.plotCell} key={ease}>
            <Plot ease={ease} id={`fp${k}`} />
            <span className={s.plotName}><R name={`fp${k}-n`}>{ease}</R></span>
          </div>
        ))}
      </div>
      <div className={s.bars}>
        {DURATIONS.map(([enter, exit], k) => (
          <div className={s.barRow} key={enter}>
            <span className={s.barName}><R name={`db${k}-n`}>{`--motion-${enter}`}</R></span>
            <span className={s.barPair}>
              <span className={s.bar} data-t={`db${k}-e`} style={{ inlineSize: `${motionDuration(enter) * PX_PER_MS}px` }} />
              {exit ? <span className={s.bar} data-kind="exit" data-t={`db${k}-x`} style={{ inlineSize: `${motionDuration(exit) * PX_PER_MS}px` }} /> : null}
            </span>
            <span className={s.barValue}><R name={`db${k}-v`}>{`${motionDuration(enter)}${exit ? ` / ${motionDuration(exit)}` : ""}ms`}</R></span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Scene 5: the same toast entering with full motion (it travels
 * --motion-distance-lg and fades), then with reduced motion (it only fades).
 */
export function ReduceDemo({ copy }: { copy: MotionCopy }) {
  return (
    <div className={s.reduce} data-m="reduce">
      <span className={s.modeStack}>
        <span className={s.modeLayer} data-t="rm-a"><R name="rm-a-t">{copy.full}</R></span>
        <span className={s.modeLayer} data-t="rm-b">{copy.reduced}</span>
      </span>
      <span className={s.toastSlot}>
        <span className={s.toastMove} data-t="rt"><Notice tone="success" icon={<CheckCircle2 size="md" />} message={<R name="rt-t">{copy.saved}</R>} /></span>
      </span>
      {/* The screen under the toast (the tall canvas shows the toast on a phone-sized page). */}
      <span className={s.screenPage}>{[0, 1, 2, 3, 4, 5, 6, 7, 8].map((line) => <span className={s.screenLine} key={line} />)}</span>
    </div>
  );
}
