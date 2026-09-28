import { useRef, type CSSProperties } from "react";
import { useTokenPx } from "../heroSequence";
import { HeroReadout } from "./HeroReadout";
import v from "../heroVariants.module.css";

/** The walk of the loop (matches hero-space-breathe): xs up to 4xl and back. */
const SPACE_STEPS = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"] as const;
const SPACE_WALK = [...SPACE_STEPS, ...SPACE_STEPS.slice(1, -1).reverse()];
const SPACE_FALLBACK = { "--space-xs": 4, "--space-sm": 8, "--space-md": 12, "--space-lg": 16, "--space-xl": 20, "--space-2xl": 24, "--space-3xl": 32, "--space-4xl": 40 };
const SPACE_CELLS = [-1, 0, 1].flatMap((row) => [-1, 0, 1].map((column) => ({ row, column })));

/** 03 Spacing: a 3x3 field breathes through the named scale, xs to 4xl and back. */
export function SpacingHero() {
  const ref = useRef<HTMLSpanElement>(null);
  const px = useTokenPx(ref, SPACE_FALLBACK);
  return (
    <>
    <span className={v.spaceField} ref={ref}>
      {SPACE_CELLS.map(({ row, column }) => (
        <span className={v.spaceBlock} data-center={row === 0 && column === 0 ? "" : undefined} key={`${row}:${column}`}
          style={{ "--r": row, "--c": column } as CSSProperties} />
      ))}
    </span>
    {/* Step k moves to the next value of the walk, so its readout names that value. */}
    <HeroReadout slots={14} poster={1} items={SPACE_WALK.map((_, k) => {
      const step = SPACE_WALK[(k + 1) % SPACE_WALK.length]!;
      return `--space-${step} · ${px[`--space-${step}`]}`;
    })} />
    </>
  );
}
