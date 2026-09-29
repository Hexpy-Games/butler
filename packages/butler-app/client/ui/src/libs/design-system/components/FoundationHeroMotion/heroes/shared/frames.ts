import type { Box } from "../../heroTimeline";
import type { HeroLayout } from "./grid";
import { BADGE_ROW, badgeCount, buildItems, nearItems, type AnnotItem } from "./guides";
import { badgeReach } from "./scene";
import type { BuildSpec, ChapterSpec, Geometry } from "./types";

/** The tall canvas lays its poster out narrower and larger, so components fill the portrait frame. */
const TALL_POSTER_ZOOM = 1.35;

/** The poster's zoom on each canvas. */
export function posterZoom(spec: ChapterSpec, layout: HeroLayout): number {
  return layout === "wide" ? spec.posterZoom ?? 1 : spec.tallPosterZoom ?? TALL_POSTER_ZOOM;
}

/**
 * Everything a build is laid out from: its frame (the component and its
 * badges, in canvas px) and its badge items per step. On the wide canvas
 * each badge stands in the nearest free space beside the component; on the
 * narrow tall canvas they stack below it (so the component can fill the
 * portrait frame).
 */
export function buildFrames(spec: ChapterSpec, g: Geometry): Array<{ build: BuildSpec; frame: Box; items: AnnotItem[][] }> {
  const pz = posterZoom(spec, g.layout);
  return spec.builds.map((build) => {
    const panel = g.panels[build.id]!;
    const steps = build.steps.map((step) => step.annots ?? []);
    if (g.layout === "wide") {
      const core = g.cores[build.id] ?? { x: 0, y: 0, w: panel.w / pz, h: panel.h / pz };
      const { items, box } = nearItems(steps, g.marks[build.id] ?? {}, `${build.id}-`, core, g.layout);
      return { build, frame: { x: panel.x + box.x * pz, y: panel.y + box.y * pz, w: box.w * pz, h: box.h * pz }, items };
    }
    const own = { x: 0, y: 0, w: panel.w / pz, h: panel.h / pz };
    const items = buildItems(steps, g.marks[build.id] ?? {}, `${build.id}-`, own, "b", badgeReach(g.layout) / pz, g.layout);
    const count = badgeCount(items);
    const below = count ? badgeReach(g.layout) + count * BADGE_ROW : 0;
    const left = count ? 12 + count * 3 : 0;
    return { build, frame: { x: panel.x - left, y: panel.y, w: panel.w + left, h: panel.h + below }, items };
  });
}
