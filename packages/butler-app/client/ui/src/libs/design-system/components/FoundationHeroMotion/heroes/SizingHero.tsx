import { useRef } from "react";
import { cn } from "../../../lib/utils";
import { flipScales, pingPong, slotStyle, useTokenPx } from "../heroSequence";
import s from "../FoundationHeroMotion.module.css";
import v from "../heroVariants.module.css";

const CONTROL_STEPS = ["xs", "sm", "md", "lg"] as const;
const CONTROL_FALLBACK = { "--control-height-xs": 24, "--control-height-sm": 28, "--control-height-md": 30, "--control-height-lg": 34 };
const CONTROL_ORDER = pingPong(CONTROL_STEPS.length);

/** 04 Sizing: a field, an icon button and a primary button grow through the control heights together. */
export function SizingHero() {
  const ref = useRef<HTMLSpanElement>(null);
  const px = useTokenPx(ref, CONTROL_FALLBACK);
  const flips = flipScales(CONTROL_STEPS.map((step) => px[`--control-height-${step}`]), CONTROL_ORDER);
  return (
    <span className={cn(v.stack, v.sizingStage)} ref={ref}>
      {CONTROL_ORDER.map((step, k) => (
        <span className={cn(s.slot, v.controlRow)} data-slots={6} data-poster={k === 2 ? "" : undefined} key={k}
          style={slotStyle(6, k, flips[k], { "--h": `var(--control-height-${CONTROL_STEPS[step]})` })}>
          <span className={v.field}><span className={v.fieldText} /></span>
          <span className={v.iconButton}><span className={v.iconGlyph} /></span>
          <span className={v.primary}><span className={v.primaryText} /></span>
        </span>
      ))}
    </span>
  );
}
