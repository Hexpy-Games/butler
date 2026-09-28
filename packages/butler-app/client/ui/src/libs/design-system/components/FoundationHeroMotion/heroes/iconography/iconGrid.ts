import type { ComponentType } from "react";
import * as Icons from "../../../Icons";
import type { IconProps, IconSize } from "../../../Icons";
import type { HeroLayout } from "../shared/grid";

/**
 * The finale's icon grid: the whole DS icon set on a grid that fills the
 * frame inside the canvas margin (17 × 9 wide, 7 × 13 on the phone's
 * portrait canvas), cells near square. Odd counts both ways, so one cell is
 * the frame's centre: the Settings gear carried in from the sidebar.
 */
export const GRID_SHAPE: Record<HeroLayout, { cols: number; rows: number; size: IconSize }> = {
  wide: { cols: 17, rows: 9, size: "2xl" },
  tall: { cols: 7, rows: 13, size: "xl" },
};

/** Every glyph of the set once (aliases dropped), Settings apart: it holds the centre. */
const SET: Array<ComponentType<IconProps>> = (() => {
  const seen = new Set<unknown>([Icons.Settings, Icons.Icon]);
  const out: Array<ComponentType<IconProps>> = [];
  for (const [name, value] of Object.entries(Icons).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof value !== "function" || !/^[A-Z]/u.test(name) || seen.has(value)) continue;
    seen.add(value);
    out.push(value as ComponentType<IconProps>);
  }
  return out;
})();

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/** A stride through the set, so glyphs of one family (arrows, panels, folders) land apart. */
const STRIDE = (() => {
  let stride = 29;
  while (gcd(stride, SET.length) !== 1) stride += 1;
  return stride;
})();

export interface GridCell {
  Glyph: ComponentType<IconProps>;
  /** Its diagonal (column + row): the draw order, top-left to bottom-right. */
  d: number;
  centre: boolean;
}

/** The cells in reading order; the set repeats after a full pass (never next to itself). */
export function gridCells(layout: HeroLayout): GridCell[] {
  const { cols, rows } = GRID_SHAPE[layout];
  const [cc, rc] = [(cols - 1) / 2, (rows - 1) / 2];
  let k = 0;
  return Array.from({ length: cols * rows }, (_, i) => {
    const [c, r] = [i % cols, Math.floor(i / cols)];
    if (c === cc && r === rc) return { Glyph: Icons.Settings, d: c + r, centre: true };
    const Glyph = SET[(k * STRIDE) % SET.length]!;
    k += 1;
    return { Glyph, d: c + r, centre: false };
  });
}

/** The centre cell's diagonal and the last diagonal. */
export function gridDiagonals(layout: HeroLayout): { centre: number; last: number } {
  const { cols, rows } = GRID_SHAPE[layout];
  return { centre: (cols - 1) / 2 + (rows - 1) / 2, last: cols + rows - 2 };
}
