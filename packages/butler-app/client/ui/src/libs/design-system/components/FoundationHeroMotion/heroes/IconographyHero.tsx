import { cn } from "../../../lib/utils";
import { ICON_SIZE, MessageSquare, Search, Sparkles, type IconSize } from "../../Icons";
import { flipScales, pingPong, slotStyle } from "../heroSequence";
import s from "../FoundationHeroMotion.module.css";
import v from "../heroVariants.module.css";
import { HeroReadout } from "./HeroReadout";

const ICON_STEPS: IconSize[] = ["xs", "sm", "md", "lg", "xl", "2xl"];
const ICON_ORDER = pingPong(ICON_STEPS.length);
const ICON_FLIPS = flipScales(ICON_STEPS.map((step) => ICON_SIZE[step]), ICON_ORDER);
const GLYPHS = [Sparkles, MessageSquare, Search];

/** 06 Iconography: three glyphs snap through the six icon sizes, each on its size box. */
export function IconographyHero() {
  return (
    <>
    <span className={cn(v.stack, v.iconStage)}>
      {ICON_ORDER.map((step, k) => (
        <span className={cn(s.slot, v.iconRow)} data-slots={10} data-poster={k === 4 ? "" : undefined} key={k}
          style={slotStyle(10, k, ICON_FLIPS[k], { "--icon-box": `var(--icon-size-${ICON_STEPS[step]})` })}>
          {GLYPHS.map((Glyph, index) => <span className={v.iconBox} key={index}><Glyph size={ICON_STEPS[step]} /></span>)}
        </span>
      ))}
    </span>
    <HeroReadout slots={10} poster={4} items={ICON_ORDER.map((step) => `--icon-size-${ICON_STEPS[step]} · ${ICON_SIZE[ICON_STEPS[step]!]}`)} />
    </>
  );
}
