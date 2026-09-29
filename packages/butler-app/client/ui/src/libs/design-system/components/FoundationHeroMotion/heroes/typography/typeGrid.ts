/**
 * The hero's layout grid, in canvas px. Every element starts and ends on a
 * column edge of this grid and on the 4px baseline (--space-xs), in every
 * beat: the CSS reads the same numbers through custom properties set on the
 * board, and the choreography places motion-only parts with `col()`.
 *
 *   wide  1040x585: 12 columns, 40 margin, 20 gutter (--space-4xl, --space-xl)
 *   tall   380x640:  4 columns, 20 margin, 12 gutter (--space-xl, --space-md)
 */
import { CANVAS, col, columnWidth, GRID, gridVars, onBaseline, TALL_BELOW, type HeroLayout } from "../shared/grid";

export { CANVAS, col, columnWidth, GRID, gridVars, onBaseline, TALL_BELOW };
export type TypeLayout = HeroLayout;

/** Specimen type size (px) and the columns it spans in Act I. */
export const SPECIMEN: Record<TypeLayout, { size: number; span: number }> = {
  wide: { size: 300, span: 8 },
  tall: { size: 170, span: 4 },
};
