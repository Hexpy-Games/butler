import type { CSSProperties, ReactNode } from "react";
import { em, POSTER_WEIGHT, specimenLayout, type SpecimenMetrics } from "./specimenMetrics";
import { Reveal } from "./Reveal";
import t from "./TypographyHero.module.css";

/** Weights whose values the changing labels cut between (drawn, pushed, settled). */
export const LABEL_WEIGHTS = [300, 800, 620] as const;
/** Dash length of each outline, in em: longer than the glyph's contours so the stroke draws from nothing. */
export const OUTLINE_EM = { a: 4, g: 7 } as const;

function px(value: number) {
  return `${Math.round(value * 100) / 100}px`;
}

function Guide({ name, axis, at, length, label, children }: {
  name: string; axis: "h" | "v"; at: number; length: number; label?: ReactNode; children?: ReactNode;
}) {
  const style = (axis === "h" ? { top: px(at), inlineSize: px(length) } : { left: px(at), blockSize: px(length) }) as CSSProperties;
  return (
    <span className={axis === "h" ? t.hline : t.vline} data-t={name} style={style}>
      <span className={t.rule} data-t={`${name}-rule`} />
      {label ? <span className={t.guideLabel} data-t={`${name}-label`}><Reveal name={`rv-${name}`}>{label}</Reveal></span> : null}
      {children}
    </span>
  );
}

/** A value that changes with the weight: one copy per labelled weight, cut in place. */
function Values({ name, values }: { name: string; values: string[] }) {
  return (
    <span className={t.values}>
      {values.map((value, k) => <span className={t.value} data-poster={k === values.length - 1 ? "" : undefined} data-t={`${name}-${k}`} key={k}>{value}</span>)}
    </span>
  );
}

/**
 * The specimen "A가" in a type designer's working view: real Pretendard
 * outlines (SVG text, stroked then filled), the vertical metrics, advance
 * widths, side bearings and the gap between the glyphs, each with its value.
 * Laid out at the Act I size and drawn smaller in the poster, where only the
 * filled glyphs show.
 */
export function Specimen({ metrics, size, lineWidth, compact }: { metrics: SpecimenMetrics; size: number; lineWidth: number; /** Short labels for the tall canvas. */ compact: boolean }) {
  const at = specimenLayout(metrics, size, POSTER_WEIGHT);
  const lines: Array<[string, number, string]> = [
    ["asc", 0, `${compact ? "asc" : "ascender"} ${em(metrics.ascender)}`],
    ["cap", at.baseline - metrics.capHeight * size, compact ? `cap ${em(metrics.capHeight)}` : `cap height ${em(metrics.capHeight)} · ${Math.round(metrics.capHeight * size)}px`],
    ["xh", at.baseline - metrics.xHeight * size, `${compact ? "x" : "x-height"} ${em(metrics.xHeight)}`],
    ["base", at.baseline, compact ? "base" : "baseline"],
    ["desc", at.height, `${compact ? "desc" : "descender"} ${em(-metrics.descender)}`],
  ];
  const gapLabel = (weight: (typeof LABEL_WEIGHTS)[number]) => {
    const [a, g] = metrics.byWeight[weight];
    return `${compact ? "" : "tracking "}${em(metrics.tracking)} · gap ${em(a.advance - a.inkRight + g.lsb + metrics.tracking)}`;
  };
  const bands: Array<[string, number, number]> = [
    ["sb-a-l", 0, at.a.lsb * size],
    ["sb-a-r", at.a.inkRight * size, (at.a.advance - at.a.inkRight) * size],
    ["sb-g-l", at.originG, at.g.lsb * size],
    ["sb-g-r", at.originG + at.g.inkRight * size, (at.g.advance - at.g.inkRight) * size],
  ];
  const text = (name: string, glyph: string, x: number, outline: boolean) => (
    <text className={outline ? t.outline : t.fillText} data-t={name} fontWeight={outline ? 300 : undefined} lang={glyph === "A" ? undefined : "ko"} x={x} y={at.baseline}
      style={outline ? ({ "--dash": px((glyph === "A" ? OUTLINE_EM.a : OUTLINE_EM.g) * size) } as CSSProperties) : undefined}>{glyph}</text>
  );
  return (
    <div className={t.specimen} data-t="specimen" style={{ inlineSize: px(at.width), blockSize: px(at.height), "--spec-size": px(size) } as CSSProperties}>
      {lines.map(([name, y, label]) => <Guide axis="h" at={y} key={name} label={label} length={lineWidth} name={`h-${name}`} />)}
      {bands.map(([name, x, width]) => (
        <span className={t.band2} data-t={name} key={name} style={{ left: px(Math.min(x, x + width)), inlineSize: px(Math.max(1, Math.abs(width))) } as CSSProperties} />
      ))}
      <Guide axis="v" at={0} length={at.height} name="v-a0" />
      <Guide axis="v" at={at.originG} length={at.height} name="v-ag">
        <span className={t.gapLabel} data-t="gap"><Reveal name="rv-gap"><Values name="gap" values={LABEL_WEIGHTS.map(gapLabel)} /></Reveal></span>
      </Guide>
      <Guide axis="v" at={at.width} length={at.height} name="v-g1" />
      {(["a", "g"] as const).map((glyph, k) => (
        <span className={t.advLabel} data-t={`adv-${glyph}`} key={glyph}
          style={{ left: px(k === 0 ? at.originG / 2 : (at.originG + at.width) / 2), top: px(at.height) } as CSSProperties}>
          <Reveal name={`rv-adv-${glyph}`}><Values name={`adv-${glyph}`} values={LABEL_WEIGHTS.map((weight) => `${compact ? "adv" : "advance"} ${em(metrics.byWeight[weight][k]!.advance)}`)} /></Reveal>
        </span>
      ))}
      <span className={t.sizeLabel} data-t="size-label"><Reveal name="rv-size">{`${compact ? "" : "Pretendard Variable · "}${size}px · wght 300`}</Reveal></span>
      <svg aria-hidden="true" className={t.glyphSvg} height={at.height} width={at.width}>
        {text("outline-a", "A", 0, true)}
        {text("outline-g", "가", at.originG, true)}
        {text("fill-a", "A", 0, false)}
        {text("fill-g", "가", at.originG, false)}
      </svg>
    </div>
  );
}

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
