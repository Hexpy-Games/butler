import { lazy, Suspense, type HTMLAttributes } from "react";
import type { DsBaseProps } from "../../lib/dsProps";

/** One hero per Foundations chapter, keyed like the chapters (01 color … 10 layout). */
export const FOUNDATION_HERO_VARIANTS = [
  "color", "typography", "spacing", "sizing", "radius", "iconography", "focus", "motion", "z-index", "layout",
] as const;

export type FoundationHeroVariant = (typeof FOUNDATION_HERO_VARIANTS)[number];

/**
 * Feature heroes: full width of their column at 16:9 (up to 36rem tall),
 * portrait 19:32 under a 45rem column, built on the shared chapter engine.
 */
export const FOUNDATION_FEATURE_HEROES: ReadonlySet<FoundationHeroVariant> = new Set<FoundationHeroVariant>(["color", "typography", "spacing", "sizing", "radius"]);

/** Language of the sample lines some heroes set (the type specimen). */
export type FoundationHeroLang = "en" | "ko";

export interface FoundationHeroMotionProps extends Omit<DsBaseProps<HTMLAttributes<HTMLDivElement>>, "children" | "lang"> {
  variant: FoundationHeroVariant;
  /** Sample-copy language; default "en". Token names and numbers never translate. */
  lang?: FoundationHeroLang;
  /** Shows the still poster frame whatever the motion setting (thumbnails, print). */
  still?: boolean;
}

const FoundationHeroStage = lazy(() => import("./FoundationHeroStage"));

/** Holds the stage's box (8:5 at most 17rem tall, or a feature hero's 16:9, as in the stage CSS) while the hero loads. */
const PLACEHOLDER = { inlineSize: "100%", aspectRatio: "8 / 5", maxBlockSize: "17rem" } as const;
const FEATURE_PLACEHOLDER = { inlineSize: "100%", aspectRatio: "16 / 9", maxBlockSize: "36rem" } as const;

/**
 * A chapter hero: a calm looping motion graphic drawn from the live tokens of
 * its foundation. CSS animations on transform and opacity only; they pause
 * offscreen or in a hidden tab and become a still poster under reduced motion.
 * Decorative: the chapter title and lead carry the meaning. The graphics load
 * on first use, so only this shell sits in the app bundle.
 */
export function FoundationHeroMotion(props: FoundationHeroMotionProps) {
  return (
    <Suspense fallback={<div aria-hidden="true" data-slot="foundation-hero-placeholder" style={FOUNDATION_FEATURE_HEROES.has(props.variant) ? FEATURE_PLACEHOLDER : PLACEHOLDER} />}>
      <FoundationHeroStage {...props} />
    </Suspense>
  );
}
