import type { CSSProperties } from "react";
import type { DsPrivateStyleProps } from "../../lib/dsProps";
import { cn } from "../../lib/utils";
import styles from "./PickOutline.module.css";

export interface PickOutlineRect { x: number; y: number; width: number; height: number }

export interface PickOutlinePick {
  /** Stable per pick (its badge pops in once). */
  id: string;
  rect: PickOutlineRect;
}

export interface PickOutlineProps extends DsPrivateStyleProps {
  /** The element under the pointer while picking: a dashed outline. */
  hover?: PickOutlineRect;
  /** The hover tag ("div.card · 158 × 236"); omit for no tag. */
  hoverLabel?: string;
  /** Picked elements in pick order: solid outlines with their 1-based index. */
  picks?: PickOutlinePick[];
  /** Layer size: badges stay inside it. */
  width: number;
  height: number;
  /** Forces reduced motion (no fade or pop); otherwise the OS setting and the DS scope apply. */
  reducedMotion?: boolean;
}

/** Room the hover tag needs above its outline; with less, the tag sits inside the outline. */
const TAG_ROOM = 26;
/** A hover outline ending closer than this to the layer's start starts its tag at the outline instead. */
const TAG_START = 180;
/** Half the index badge: a pick at the layer's edge keeps its whole badge inside the layer. */
const BADGE_HALF = 11;

const box = (rect: PickOutlineRect): CSSProperties => ({ width: rect.width, height: rect.height, translate: `${rect.x}px ${rect.y}px` });

function badgeAt(rect: PickOutlineRect, width: number, height: number): CSSProperties {
  const x = Math.min(Math.max(rect.x, BADGE_HALF), width - BADGE_HALF);
  const y = Math.min(Math.max(rect.y, BADGE_HALF), height - BADGE_HALF);
  return { translate: `${x}px ${y}px` };
}

/**
 * The user's pick marks for the transparent overlay layer above a page (never the page DOM): a dashed
 * outline with a size tag on the element under the pointer, and solid outlines with an index badge on the
 * picks. An ink stroke between white keylines reads on white, black and photo pages. Pure presenter with
 * no App store; the overlay renderer passes rects in layer pixels. Always drawn with the light inks.
 */
export function PickOutline({ hover, hoverLabel, picks = [], width, height, reducedMotion, className }: PickOutlineProps) {
  const tagBelow = hover ? hover.y < TAG_ROOM : false;
  const tagStart = hover ? hover.x + hover.width < TAG_START : false;
  return (
    <div className={cn("theme-light", styles.layer, className)} data-slot="pick-outline" data-reduced={reducedMotion ? "true" : undefined}
      aria-hidden="true">
      {picks.map((pick) => <span key={`outline-${pick.id}`} className={styles.picked} style={box(pick.rect)} data-pick-outline="picked" />)}
      {hover ? (
        <span className={styles.hover} style={box(hover)} data-pick-outline="hover" data-tag-below={tagBelow || undefined}
          data-tag-start={tagStart || undefined}>
          {hoverLabel ? <span className={styles.tag}>{hoverLabel}</span> : null}
        </span>
      ) : null}
      {picks.map((pick, index) => (
        <span key={`badge-${pick.id}`} className={styles.badge} style={badgeAt(pick.rect, width, height)} data-pick-badge="">
          {index + 1 > 99 ? "99+" : index + 1}
        </span>
      ))}
    </div>
  );
}
