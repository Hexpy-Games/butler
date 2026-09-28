import type { Box } from "../../heroTimeline";
import { CANVAS, GRID, type HeroLayout } from "./grid";
import { relBox } from "./measure";
import type { ChapterSpec } from "./types";

/**
 * The finale's packing: the poster's items (the token field and each
 * component) laid out like a bento grid that fills the frame exactly. Items
 * keep their natural size, scaled together as large as the frame allows;
 * each sits centred on a tile that fills its cell, so the frame has no holes.
 */
export interface Pack {
  /** The poster's scale over its natural size. */
  scale: number;
  /** Each item's tile, in canvas px ("field" and the build ids). */
  tiles: Record<string, Box>;
  /** Each item's natural size, in canvas px at the unscaled poster zoom. */
  natural: Record<string, { w: number; h: number }>;
}

/** Whether an element paints something (text, a fill, a border, a shadow, an image). */
function paints(node: Element): boolean {
  if ([...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim())) return true;
  const style = getComputedStyle(node);
  return style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none" || style.borderTopWidth !== "0px" || style.boxShadow !== "none" || node.tagName === "IMG";
}

/** Whether a node is visible up to `stop` (no transparent or hidden ancestor). */
function shows(node: Element, stop: Element): boolean {
  for (let n: Element | null = node; n && n !== stop; n = n.parentElement) {
    const style = getComputedStyle(n);
    if (style.opacity === "0" || style.visibility === "hidden" || style.display === "none") return false;
  }
  return true;
}

/** The box an element's painted content covers (the real component, not its stretched cell), in canvas px. */
export function contentBox(element: HTMLElement, origin: DOMRect, ratio: number): Box {
  const rects = [...element.querySelectorAll("*")]
    .filter((node) => (node instanceof SVGSVGElement || (!(node instanceof SVGElement) && paints(node))) && shows(node, element))
    .map((node) => node.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) return relBox(element.getBoundingClientRect(), origin, ratio);
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return relBox(new DOMRect(left, top, right - left, bottom - top), origin, ratio);
}

/** Natural sizes of the poster's items as the chapter lays them out, in canvas px; null until laid out. */
export function measureNatural(root: HTMLElement, spec: ChapterSpec): Array<{ id: string; w: number; h: number }> | null {
  const world = root.querySelector<HTMLElement>('[data-t="world"]');
  const field = root.querySelector<HTMLElement>('[data-t="field-mover"]');
  if (!world || !field || world.offsetWidth === 0) return null;
  const origin = world.getBoundingClientRect();
  const ratio = origin.width / CANVAS.wide.w;
  const items = [{ id: "field", node: field as HTMLElement | null }, ...spec.builds.map((build) => ({ id: build.id, node: root.querySelector<HTMLElement>(`[data-t="surface-${build.id}"]`) }))];
  if (items.some((item) => !item.node)) return null;
  return items.map(({ id, node }) => {
    // The field is sized by its own root (scene overlays reach far past it); a component by what it paints.
    const root = id === "field" ? node!.querySelector<HTMLElement>(":scope > :not([data-t^='tile'])") : null;
    const box = root ? relBox(root.getBoundingClientRect(), origin, ratio) : contentBox(node!, origin, ratio);
    return { id, w: box.w, h: box.h };
  });
}

/** Every way to cut the ordered items into `k` consecutive columns. */
function partitions<T>(items: T[], k: number): T[][][] {
  if (k === 1) return [[items]];
  const out: T[][][] = [];
  for (let cut = 1; cut <= items.length - k + 1; cut += 1) {
    for (const rest of partitions(items.slice(cut), k - 1)) out.push([items.slice(0, cut), ...rest]);
  }
  return out;
}

/** Largest scale for no item to be drawn bigger than this (product fidelity). */
const MAX_SCALE = 1.3;

/** Tiles of one packing: columns share the frame's width in proportion to their width; each column's tiles share its height the same way. */
function tilesOf(cols: Array<Array<{ id: string; w: number; h: number }>>, frame: Box, gap: number): Record<string, Box> {
  const widths = cols.map((col) => Math.max(...col.map((item) => item.w)));
  const spare = frame.w - gap * (cols.length - 1);
  const total = widths.reduce((sum, w) => sum + w, 0);
  const tiles: Record<string, Box> = {};
  let x = frame.x;
  cols.forEach((col, c) => {
    const w = (spare * widths[c]!) / total;
    const room = frame.h - gap * (col.length - 1);
    const heights = col.reduce((sum, item) => sum + item.h, 0);
    let y = frame.y;
    for (const item of col) {
      const h = (room * item.h) / heights;
      tiles[item.id] = { x, y, w, h };
      y += h + gap;
    }
    x += w + gap;
  });
  return tiles;
}

/**
 * Packs the items into 2–3 columns filling the wide canvas's frame exactly.
 * The best packing draws the items large and fills each tile evenly (no
 * small component alone on a tall tile): scale times the geometric mean of
 * how much of its tile each item covers.
 */
export function packPoster(items: Array<{ id: string; w: number; h: number }>, layout: HeroLayout = "wide"): Pack {
  const { margin, gutter: gap } = GRID[layout];
  const frame = { x: margin, y: margin, w: CANVAS[layout].w - 2 * margin, h: CANVAS[layout].h - 2 * margin };
  let best: { score: number; scale: number; tiles: Record<string, Box> } | null = null;
  for (const k of [2, 3]) {
    if (items.length < k) continue;
    for (const cols of partitions(items, k)) {
      const widths = cols.map((col) => Math.max(...col.map((item) => item.w)));
      const across = (frame.w - gap * (k - 1)) / widths.reduce((sum, w) => sum + w, 0);
      const down = Math.min(...cols.map((col) => (frame.h - gap * (col.length - 1)) / col.reduce((sum, item) => sum + item.h, 0)));
      const scale = Math.min(MAX_SCALE, across, down);
      const tiles = tilesOf(cols, frame, gap);
      const cover = items.reduce((sum, item) => sum + Math.log(Math.min(1, (scale * scale * item.w * item.h) / (tiles[item.id]!.w * tiles[item.id]!.h))), 0);
      const score = scale * Math.exp(cover / items.length);
      if (!best || score > best.score) best = { score, scale, tiles };
    }
  }
  const natural = Object.fromEntries(items.map((item) => [item.id, { w: item.w, h: item.h }]));
  return best ? { scale: best.scale, tiles: best.tiles, natural } : { scale: 1, tiles: tilesOf([items], frame, gap), natural };
}
