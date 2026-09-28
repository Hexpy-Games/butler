import { cn } from "../../../lib/utils";
import { pingPong, slotStyle } from "../heroSequence";
import s from "../FoundationHeroMotion.module.css";
import v from "../heroVariants.module.css";

/** Stops along the Pretendard Variable weight axis (45–920). */
const WEIGHTS = [45, 154, 264, 373, 483, 592, 701, 811, 920];
const WEIGHT_ORDER = pingPong(WEIGHTS.length);

/** 02 Typography: the specimen sweeps the variable weight axis and back; a thumb tracks it. */
export function TypographyHero() {
  return (
    <span className={v.typeStage}>
      <span className={v.typeGlyphs}>
        {WEIGHT_ORDER.map((weight, k) => (
          <span className={cn(s.slot, v.glyph)} data-slots={16} data-poster={k === 5 ? "" : undefined} key={k}
            style={slotStyle(16, k, {}, { "--weight": WEIGHTS[weight]! })}>
            Aa<span lang="ko">가</span>
          </span>
        ))}
      </span>
      <span className={v.axis}>
        {WEIGHTS.map((weight) => <span className={v.tick} key={weight} />)}
        <span className={v.thumb} />
      </span>
    </span>
  );
}
