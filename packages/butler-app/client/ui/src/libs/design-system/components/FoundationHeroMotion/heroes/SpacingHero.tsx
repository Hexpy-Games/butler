import { type CSSProperties } from "react";
import v from "../heroVariants.module.css";

const SPACE_CELLS = [-1, 0, 1].flatMap((row) => [-1, 0, 1].map((column) => ({ row, column })));

/** 03 Spacing: a 3x3 field breathes through the named scale, xs to 4xl and back. */
export function SpacingHero() {
  return (
    <span className={v.spaceField}>
      {SPACE_CELLS.map(({ row, column }) => (
        <span className={v.spaceBlock} data-center={row === 0 && column === 0 ? "" : undefined} key={`${row}:${column}`}
          style={{ "--r": row, "--c": column } as CSSProperties} />
      ))}
    </span>
  );
}
