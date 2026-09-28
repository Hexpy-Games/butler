import type { CSSProperties } from "react";
import type { TypeCopy } from "./typeCopy";
import { AXIS, POSTER_WEIGHT, SWEEP, WEIGHT_TOKENS } from "./typeChoreography";
import t from "./TypographyHero.module.css";

/** Axis position (0..1) of a weight on the Pretendard Variable axis. */
export function axisAt(weight: number): number {
  return (weight - AXIS.min) / (AXIS.max - AXIS.min);
}

/**
 * The poster's type specimen: "Aa가" in one copy per sweep stop (only one is
 * shown at a time, cut in place) with the poster weight split into its Latin
 * and Hangul halves so they can part and meet again.
 */
export function Glyph() {
  return (
    <div className={t.glyphBox} data-t="glyph-fade">
      <span className={t.glyphSizer}>Aa<span lang="ko">가</span></span>
      <div className={t.glyph} data-t="glyph">
      {SWEEP.map((weight, k) => (weight === POSTER_WEIGHT && k === SWEEP.lastIndexOf(POSTER_WEIGHT) ? (
        <span className={t.stop} data-poster="" data-t={`stop-${k}`} key={k} style={{ "--weight": weight } as CSSProperties}>
          <span className={t.half} data-t="latin">Aa</span>
          <span className={t.half} data-t="hangul" lang="ko">가</span>
        </span>
      ) : (
        <span className={t.stop} data-t={`stop-${k}`} key={k} style={{ "--weight": weight } as CSSProperties}>Aa<span lang="ko">가</span></span>
      )))}
      </div>
    </div>
  );
}

/**
 * Parts of Act I that live only in motion (hidden in the poster): the weight
 * axis (45–920) with the four weight tokens on it and a thumb that scrubs
 * with the specimen, and the Latin/Hangul captions. The timeline places them
 * around the big specimen.
 */
export function SpecimenOverlay({ copy }: { copy: TypeCopy }) {
  return (
    <>
      <div className={t.overlay} data-t="axis">
        <span className={t.axisRow}>
          <span className={t.mono}>{`wght ${AXIS.min}`}</span>
          <span className={t.axisTrack} data-t="track">
            <span className={t.axisTicks} data-t="ticks">
              {WEIGHT_TOKENS.map(([name, weight]) => (
                <span className={t.axisTick} key={name} style={{ "--x": axisAt(weight) } as CSSProperties}>
                  <span className={t.axisTickLabel}>{weight}</span>
                </span>
              ))}
            </span>
            <span className={t.axisThumb} data-t="thumb" />
          </span>
          <span className={t.mono}>{AXIS.max}</span>
        </span>
        <span className={t.weights} data-t="weights">{`--font-weight-*  ${WEIGHT_TOKENS.map(([name, weight]) => `${name} ${weight}`).join(" · ")}`}</span>
      </div>
      <span className={t.overlay} data-t="cap-latin"><span className={t.caption}>{copy.latin}</span></span>
      <span className={t.overlay} data-t="cap-hangul"><span className={t.caption}>{copy.hangul}</span></span>
      <span className={t.overlay} data-t="cap-stack"><span className={t.mono}>{copy.stack}</span></span>
      <span className={t.overlay} data-t="cap-tnum"><span className={t.mono}>font-variant-numeric: tabular-nums</span></span>
    </>
  );
}
