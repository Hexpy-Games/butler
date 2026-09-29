import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { HeroLayout } from "../shared/grid";
import { GRID_SHAPE, gridCells } from "./iconGrid";
import { STROKES } from "./iconParts";
import s from "./IconHero.module.css";

/**
 * The finale: the whole DS icon set on a grid filling the frame, the gear
 * at its centre. Each glyph's strokes get a unit path length so the timeline
 * draws every glyph, one diagonal at a time (`data-d`); `data-drawn` turns the
 * dash on once the lengths are set.
 */
export function IconGrid({ layout }: { layout: HeroLayout }) {
  const ref = useRef<HTMLDivElement>(null);
  const { cols, rows, size } = GRID_SHAPE[layout];
  const cells = gridCells(layout);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid) return;
    for (const stroke of grid.querySelectorAll(`[data-d] ${STROKES}`)) stroke.setAttribute("pathLength", "100");
    grid.dataset.drawn = "";
  }, [layout]);
  return (
    <div className={s.iconGrid} data-t="grid" ref={ref} style={{ "--cols": cols, "--rows": rows } as CSSProperties}>
      {cells.map(({ Glyph: Icon, d, centre }, k) => (
        <span className={s.gridCell} data-centre={centre ? "" : undefined} data-d={centre ? undefined : d} data-m={centre ? "gear" : undefined} key={k}>
          <Icon size={size} />
        </span>
      ))}
    </div>
  );
}
