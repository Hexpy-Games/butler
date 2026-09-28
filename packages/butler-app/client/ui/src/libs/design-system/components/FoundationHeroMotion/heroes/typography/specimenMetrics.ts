/**
 * Real font metrics of the specimen "A가", measured from the live --font-body
 * (Pretendard Variable) with canvas text metrics: vertical metrics in em, and
 * per weight the advance and side bearings of each glyph. The guides and
 * their values are drawn from these, so they sit on the actual letterforms.
 */
export const GLYPHS = ["A", "가"] as const;
/** Weights the specimen passes through: drawn at 300, pushed to 800, settled on --font-weight-strong. */
export const SPEC_WEIGHTS = [300, 550, 800, 710, 620] as const;
export type SpecWeight = (typeof SPEC_WEIGHTS)[number];
export const POSTER_WEIGHT = 620;

export interface GlyphMetrics {
  /** Advance, left side bearing and ink right edge, in em. */
  advance: number;
  lsb: number;
  inkRight: number;
}

export interface SpecimenMetrics {
  ascender: number;
  descender: number;
  capHeight: number;
  xHeight: number;
  /** Letter-spacing of the display role (em), read from the live token. */
  tracking: number;
  byWeight: Record<SpecWeight, [GlyphMetrics, GlyphMetrics]>;
}

const PROBE = 200;

/** Null when canvas text metrics are unavailable (the hero then keeps its poster). */
export function measureSpecimen(family: string, tracking: number): SpecimenMetrics | null {
  if (typeof document === "undefined") return null;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return null;
  const at = (weight: number) => {
    context.font = `${weight} ${PROBE}px ${family}`;
    return (text: string) => context.measureText(text);
  };
  const regular = at(POSTER_WEIGHT);
  const box = regular("A");
  if (!box.fontBoundingBoxAscent) return null;
  const glyph = (weight: number, text: string): GlyphMetrics => {
    const m = at(weight)(text);
    return { advance: m.width / PROBE, lsb: -m.actualBoundingBoxLeft / PROBE, inkRight: m.actualBoundingBoxRight / PROBE };
  };
  return {
    ascender: box.fontBoundingBoxAscent / PROBE,
    descender: box.fontBoundingBoxDescent / PROBE,
    capHeight: regular("H").actualBoundingBoxAscent / PROBE,
    xHeight: regular("x").actualBoundingBoxAscent / PROBE,
    tracking,
    byWeight: Object.fromEntries(SPEC_WEIGHTS.map((weight) => [weight, [glyph(weight, "A"), glyph(weight, "가")]])) as SpecimenMetrics["byWeight"],
  };
}

/** Glyph origins and box size (px) at one weight, with the tracking between them. */
export function specimenLayout(metrics: SpecimenMetrics, size: number, weight: SpecWeight) {
  const [a, g] = metrics.byWeight[weight];
  const gap = metrics.tracking * size;
  const originG = a.advance * size + gap;
  return {
    originG,
    width: originG + g.advance * size,
    height: (metrics.ascender + metrics.descender) * size,
    baseline: metrics.ascender * size,
    a, g,
  };
}

export function em(value: number): string {
  return `${Math.round(value * 1000) / 1000}em`;
}

/** Font ascent and descent (px) of `text` set in a CSS `font`, for placing a baseline; null without canvas metrics. */
export function fontBox(font: string, text: string): { ascent: number; descent: number } | null {
  const context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!context) return null;
  context.font = font;
  const metrics = context.measureText(text);
  return metrics.fontBoundingBoxAscent ? { ascent: metrics.fontBoundingBoxAscent, descent: metrics.fontBoundingBoxDescent } : null;
}
