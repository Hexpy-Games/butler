import type { CSSProperties } from "react";
import { Reveal } from "./Reveal";
import t from "./TypographyHero.module.css";

/**
 * The weight control of Act I: the variable axis with the weight tokens, a
 * thumb, and a readout whose digits roll with the weight (hundreds and tens
 * on strips, so 300 → 800 → 620 counts through every ten).
 */
export function WeightControl({ axisAt }: { axisAt: (weight: number) => number }) {
  return (
    <div className={t.overlay} data-t="control">
      <span className={t.mono}><Reveal name="rv-fw">font-weight</Reveal></span>
      <span className={t.readout}>
        <span className={t.digit}><span className={t.digitStrip} data-t="read-100" style={{ "--d": 6 } as CSSProperties}>
          {Array.from({ length: 10 }, (_, n) => <span key={n}>{n}</span>)}
        </span><span className={t.digitSpace}>6</span></span>
        <span className={t.digit}><span className={t.digitStrip} data-t="read-10" style={{ "--d": 62 } as CSSProperties}>
          {Array.from({ length: 90 }, (_, n) => <span key={n}>{n % 10}</span>)}
        </span><span className={t.digitSpace}>2</span></span>
        <span>0</span>
      </span>
      <span className={t.controlTrack} data-t="control-track">
        {[400, 500, 560, 620].map((weight) => <span className={t.axisTick} key={weight} style={{ "--x": axisAt(weight) } as CSSProperties} />)}
        <span className={t.axisThumb} data-t="thumb" />
      </span>
      <span className={t.controlScale}><span className={t.mono}><Reveal name="rv-45">45</Reveal></span><span className={t.mono}><Reveal name="rv-920">920</Reveal></span></span>
      <span className={t.mono} data-t="token"><Reveal name="rv-token">--font-weight-strong</Reveal></span>
    </div>
  );
}
