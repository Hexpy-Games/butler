import type { Box } from "../../heroTimeline";
import type { HeroLayout } from "./grid";
import { BADGE_ROW, badgeCount, buildItems, type AnnotItem } from "./guides";
import { BADGE_CHAR, BADGE_GUTTER, badgeReach } from "./scene";
import type { BuildSpec, ChapterSpec, Geometry } from "./types";

/** The tall canvas lays its poster out narrower and larger, so components fill the portrait frame. */
const TALL_POSTER_ZOOM = 1.35;

/** The poster's zoom on each canvas. */
export function posterZoom(spec: ChapterSpec, layout: HeroLayout): number {
  return layout === "wide" ? spec.posterZoom ?? 1 : spec.tallPosterZoom ?? TALL_POSTER_ZOOM;
}

/**
 * Everything a build is laid out from: its gutter-framed box and its badge
 * items per step. Badges stand in a gutter beside the component, or below it
 * on the narrow tall canvas (so the component can fill the portrait frame).
 */
export function buildFrames(spec: ChapterSpec, g: Geometry): Array<{ build: BuildSpec; frame: Box; items: AnnotItem[][] }> {
  const pz = posterZoom(spec, g.layout);
  const tall = g.layout === "tall";
  return spec.builds.map((build) => {
    const panel = g.panels[build.id]!;
    const side = tall ? "b" : build.side ?? "l";
    const own = { x: 0, y: 0, w: panel.w / pz, h: panel.h / pz };
    const items = buildItems(build.steps.map((step) => step.annots ?? []), g.marks[build.id] ?? {}, `${build.id}-`, own, side, badgeReach(g.layout) / pz, g.layout);
    const count = badgeCount(items);
    if (side === "b") {
      const below = count ? badgeReach(g.layout) + count * BADGE_ROW : 0;
      const left = count ? 12 + count * 3 : 0;
      return { build, frame: { x: panel.x - left, y: panel.y, w: panel.w + left, h: panel.h + below }, items };
    }
    // The gutter holds the widest badge (estimated from its longest step) at its reach, in canvas px.
    const widest = Math.max(0, ...items.flat().map((item) => (item.badge ? Math.max(...item.badge.text.map((text) => [...text].length)) : 0)));
    const gutter = widest ? Math.max(BADGE_GUTTER[g.layout], (badgeReach(g.layout) / pz + widest * BADGE_CHAR + 24) * pz) : 0;
    const frame = side === "l" ? { ...panel, x: panel.x - gutter, w: panel.w + gutter } : { ...panel, w: panel.w + gutter };
    return { build, frame, items };
  });
}
