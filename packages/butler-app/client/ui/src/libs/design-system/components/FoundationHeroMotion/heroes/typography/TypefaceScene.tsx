import type { CSSProperties } from "react";
import { AXIS_MAX, AXIS_MIN, axisPosition, SWEEP, sweepAt } from "./typeTimeline";
import t from "./TypographyHero.module.css";

const LAST = SWEEP.length - 1;
/** Distinct stops, drawn as ticks on the axis. */
const TICKS = [...new Set(SWEEP)].sort((a, b) => a - b);

function stopStyle(k: number): CSSProperties {
  return { "--at": sweepAt(k) } as CSSProperties;
}

function stopRole(k: number): string {
  return k === 0 ? "first" : k === LAST ? "last" : "step";
}

/**
 * Scene 1, the typeface: one Pretendard Variable specimen, Latin and Hangul
 * together, sweeps the weight axis from the brand weight to 45, up to 920 and
 * back, while a tabular readout and a thumb on the axis step with it (both
 * cut from stop to stop, so the main thread animates nothing continuous).
 */
export function TypefaceScene() {
  return (
    <div className={t.scene} data-scene="typeface">
      <div className={t.specimen}>
        {SWEEP.map((weight, k) => (
          <span className={t.stop} data-stop={stopRole(k)} key={k} style={{ ...stopStyle(k), "--weight": weight } as CSSProperties}>
            Aa<span lang="ko">가</span>
          </span>
        ))}
      </div>
      <div className={t.axisRow}>
        <span className={t.code}>wght</span>
        <span className={t.axis}>
          {TICKS.map((weight) => <span className={t.tick} key={weight} style={{ "--x": axisPosition(weight) } as CSSProperties} />)}
          {SWEEP.map((weight, k) => (
            <span className={t.stop} data-stop={stopRole(k)} data-thumb="" key={k} style={{ ...stopStyle(k), "--x": axisPosition(weight) } as CSSProperties} />
          ))}
        </span>
        <span className={t.readout}>
          {SWEEP.map((weight, k) => <span className={t.stop} data-stop={stopRole(k)} key={k} style={stopStyle(k)}>{weight}</span>)}
        </span>
      </div>
      <div className={t.family}>
        <span>Pretendard Variable</span>
        <span className={t.code}>{`${AXIS_MIN}–${AXIS_MAX}`}</span>
      </div>
    </div>
  );
}
