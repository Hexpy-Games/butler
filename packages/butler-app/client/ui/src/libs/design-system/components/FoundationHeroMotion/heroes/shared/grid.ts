/**
 * The feature heroes' layout grid, in canvas px. Every element starts and
 * ends on a column edge and on the 4px baseline (--space-xs); the CSS reads
 * the same numbers through custom properties set on the board.
 *
 *   wide  1040x585: 12 columns, 40 margin, 20 gutter (--space-4xl, --space-xl)
 *   tall   380x640:  4 columns, 20 margin, 12 gutter (--space-xl, --space-md)
 */
export const CANVAS = { wide: { w: 1040, h: 585 }, tall: { w: 380, h: 640 } } as const;
export type HeroLayout = keyof typeof CANVAS;

/** Width (css px) below which the tall canvas is used. */
export const TALL_BELOW = 720;

export const GRID: Record<HeroLayout, { columns: number; margin: number; gutter: number; baseline: number }> = {
  wide: { columns: 12, margin: 40, gutter: 20, baseline: 4 },
  tall: { columns: 4, margin: 20, gutter: 12, baseline: 4 },
};

export function columnWidth(layout: HeroLayout): number {
  const { columns, margin, gutter } = GRID[layout];
  return (CANVAS[layout].w - margin * 2 - gutter * (columns - 1)) / columns;
}

/** Left edge of column `start` (1-based) and the width of `span` columns. */
export function col(layout: HeroLayout, start: number, span = 1): { x: number; w: number } {
  const { margin, gutter } = GRID[layout];
  const width = columnWidth(layout);
  return { x: margin + (start - 1) * (width + gutter), w: span * width + (span - 1) * gutter };
}

/** Snaps a length to the baseline grid. */
export function onBaseline(value: number, layout: HeroLayout): number {
  const step = GRID[layout].baseline;
  return Math.round(value / step) * step;
}

/** Custom properties that hand the grid to the stylesheet (the token column spans `tokens` columns on the wide canvas). */
export function gridVars(layout: HeroLayout, tokens = 5): Record<string, string> {
  const { margin, gutter, columns } = GRID[layout];
  return {
    "--grid-margin": `${margin}px`,
    "--grid-gutter": `${gutter}px`,
    "--grid-columns": String(columns),
    "--grid-tokens": `${col(layout, 1, layout === "wide" ? tokens : 4).w}px`,
  };
}
