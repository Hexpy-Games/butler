import type { Box } from "../../heroTimeline";
import type { HeroLayout } from "./grid";
import { round, shape, type AnnotItem } from "./guideShapes";
import type { Annot, Marks, Measured } from "./types";

export type { AnnotItem, Badge, Guide, Note, Place } from "./guideShapes";

/** The distance between two boxes along the axis that separates them (0 when they touch or overlap). */
function gapOf(p: Box, q: Box): number {
  return q.y >= p.y + p.h - 0.5 ? q.y - (p.y + p.h) : Math.max(0, q.x - (p.x + p.w));
}

/** What an annotation measures, handed to its label as `value`. */
function valueOf(annot: Annot, m: Measured, marks: Marks): number | undefined {
  switch (annot.kind) {
    case "gap": return marks[annot.to] ? gapOf(m.box, marks[annot.to]!.box) : undefined;
    case "pad": return Math.max(...m.pad);
    case "size": return annot.axis === "h" ? m.box.h : m.box.w;
    case "radius": return m.r;
    case "box": return annot.inflateTo ? Math.max(m.box.h, marks[annot.inflateTo]?.box.h ?? 0) : m.box.h + 2 * (annot.inflate ?? 0);
    case "shadow": return m.shadow?.blur;
    default: return undefined;
  }
}

function labelOf(annot: Annot, marks: Marks, layout: HeroLayout): string[] | undefined {
  if (!annot.label) return undefined;
  if (Array.isArray(annot.label)) return annot.label;
  const own = marks[annot.kind === "gap" ? annot.from : annot.kind === "contrast" ? annot.fg : annot.target];
  return own ? annot.label({ ...own, value: valueOf(annot, own, marks) }, marks, layout) : undefined;
}

/** Guides and inline values of the opening subject (one state). */
export function openingItems(annots: Annot[], marks: Marks, prefix: string, layout: HeroLayout): AnnotItem[] {
  return annots.flatMap((annot, k): AnnotItem[] => {
    const text = labelOf(annot, marks, layout);
    const drawn = text?.length === 0 ? null : shape(annot, marks);
    if (!drawn) return [];
    return [{ id: `${prefix}${k}`, guides: drawn.guides, anchor: drawn.anchor, note: text ? { ...drawn.note, text } : undefined }];
  });
}

/** Vertical pitch between stacked badges in a gutter (canvas px). */
const PITCH = 28;

/**
 * Guides and gutter badges of one build, step by step: each badge stands far
 * out in the gutter (`far` past the panel edge: left, right, or below it on
 * the narrow tall canvas), badges never overlap, and a leader runs from each
 * badge to its guide. Returns items per step.
 */
export function buildItems(steps: Annot[][], marks: Marks, prefix: string, panel: Box, side: "l" | "r" | "b", far: number, layout: HeroLayout): AnnotItem[][] {
  const items = steps.map((annots, j) => annots.flatMap((annot, k): Array<AnnotItem & { text?: string[] }> => {
    const text = labelOf(annot, marks, layout);
    const drawn = text?.length === 0 ? null : shape(annot, marks);
    return drawn ? [{ id: `${prefix}${j}-${k}`, guides: drawn.guides, anchor: drawn.anchor, text }] : [];
  }));
  const labelled = items.flat().filter((item) => item.text).sort((a, b) => a.anchor.y - b.anchor.y);
  let last = Number.NEGATIVE_INFINITY;
  labelled.forEach((item, n) => {
    const { anchor } = item;
    if (side === "b") {
      // Below the component, one badge per row; the leader climbs the component's left edge (each on its own line) and turns in.
      const y = panel.h + far + n * PITCH;
      const x0 = -8 - n * 3;
      const d = `M-4 ${round(y)}H${round(x0)}V${round(anchor.y)}H${round(anchor.x)}`;
      item.badge = { x: 0, y, side, text: item.text!, leader: { d, len: Math.ceil(Math.abs(x0 + 4) + Math.abs(y - anchor.y) + Math.abs(anchor.x - x0)) } };
      return;
    }
    const y = Math.max(anchor.y, last + PITCH);
    last = y;
    const x = side === "l" ? -far : panel.w + far;
    const knee = side === "l" ? Math.min(-10, anchor.x - 8) : Math.max(panel.w + 10, anchor.x + 8);
    const start = side === "l" ? x + 6 : x - 6;
    const d = `M${round(start)} ${round(y)}H${round(knee)}L${round(anchor.x)} ${round(anchor.y)}`;
    const len = Math.ceil(Math.abs(knee - start) + Math.hypot(anchor.x - knee, anchor.y - y));
    item.badge = { x, y, side, text: item.text!, leader: { d, len } };
  });
  return items.map((list) => list.map(({ text: _text, ...item }) => item));
}

/** How many badges a build's items carry. */
export const badgeCount = (items: AnnotItem[][]) => items.flat().filter((item) => item.badge).length;
export { PITCH as BADGE_ROW };
