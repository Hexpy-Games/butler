import { useRef, type ComponentType } from "react";
import { cn } from "../../lib/utils";
import type { FoundationHeroMotionProps, FoundationHeroVariant } from "./FoundationHeroMotion";
import { useHeroPlayback } from "./heroPlayback";
import { ColorHero } from "./heroes/ColorHero";
import { FocusHero } from "./heroes/FocusHero";
import { IconographyHero } from "./heroes/IconographyHero";
import { LayersHero } from "./heroes/LayersHero";
import { LayoutHero } from "./heroes/LayoutHero";
import { MotionHero } from "./heroes/MotionHero";
import { RadiusHero } from "./heroes/RadiusHero";
import { SizingHero } from "./heroes/SizingHero";
import { SpacingHero } from "./heroes/SpacingHero";
import { TypographyHero } from "./heroes/TypographyHero";
import styles from "./FoundationHeroMotion.module.css";

export const FOUNDATION_HERO_RENDERERS: Record<FoundationHeroVariant, ComponentType> = {
  color: ColorHero,
  typography: TypographyHero,
  spacing: SpacingHero,
  sizing: SizingHero,
  radius: RadiusHero,
  iconography: IconographyHero,
  focus: FocusHero,
  motion: MotionHero,
  "z-index": LayersHero,
  layout: LayoutHero,
};

/**
 * The hero itself, loaded on demand by FoundationHeroMotion so its graphics
 * and keyframes stay out of the app's eager bundle.
 */
export default function FoundationHeroStage({ variant, still = false, className, ...props }: FoundationHeroMotionProps) {
  const ref = useRef<HTMLDivElement>(null);
  const playback = useHeroPlayback(ref, still);
  const Hero = FOUNDATION_HERO_RENDERERS[variant];
  return (
    <div
      {...props}
      ref={ref}
      className={cn(styles.stage, className)}
      data-slot="foundation-hero"
      data-hero-variant={variant}
      data-hero-state={playback}
      aria-hidden="true"
    >
      <Hero />
    </div>
  );
}
