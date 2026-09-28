import type { Box } from "../../heroTimeline";
import { CANVAS, GRID, type HeroLayout } from "./grid";
import { relBox } from "./measure";
import type { ChapterSpec } from "./types";

/**
 * The finale's packing (wide canvas): the poster's items (the token field and
 * each component) set straight on the page, in columns, each at the size its
 * real content paints. No tiles, panels or fills: the components themselves
 * fill the frame, as in the Typography finale. Every item keeps the layout
 * width it had in the chapter's poster (so nothing reflows, wraps or clips);
 * the whole poster is scaled together as large as the frame allows.
 */
export interface Pack {
  /** The poster's scale over its natural size. */
  scale: number;
  /** Where each item's painted content sits, in canvas px ("field" and the build ids). */
  slots: Record<string, Box>;
  /** Each item as measured, in canvas px at the unscaled poster zoom. */
  natural: Record<string, PackItem>;
}

/**
 * One item as the chapter lays it out: `w`, `h` what its content paints;
 * `dx`, `dy` where that starts inside the item's own box; `cw` the item box's
 * width (the width it is laid out at in the packed poster too).
 */
export interface PackItem {
  id: string;
  w: number;
  h: number;
  dx: number;
  dy: number;
  cw: number;
}

/** A chapter's finale composition (ChapterSpec.finale). */
export interface ChapterFinale {
  /** Wide: columns of item ids ("field", build ids), left to right, each stacked; default: the 2–3 consecutive columns that draw largest. */
  columns?: string[][];
  /** Tall: frame the whole poster (default), or the components alone (the field had its own scene) so nothing is drawn small beside empty bands. */
  tall?: "poster" | "product";
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

/** The poster's items as the chapter lays them out, in canvas px; null until laid out. */
export function measureNatural(root: HTMLElement, spec: ChapterSpec): PackItem[] | null {
  const world = root.querySelector<HTMLElement>('[data-t="world"]');
  const field = root.querySelector<HTMLElement>('[data-t="field-mover"]');
  if (!world || !field || world.offsetWidth === 0) return null;
  const ratio = world.getBoundingClientRect().width / CANVAS.wide.w;
  const items = [
    { id: "field", box: field as HTMLElement | null, paint: field.firstElementChild as HTMLElement | null },
    ...spec.builds.map((build) => ({ id: build.id, box: root.querySelector<HTMLElement>(`[data-panel="${build.id}"]`), paint: root.querySelector<HTMLElement>(`[data-t="surface-${build.id}"]`) })),
  ];
  if (items.some((item) => !item.box || !item.paint)) return null;
  return items.map(({ id, box, paint }) => {
    const own = box!.getBoundingClientRect();
    // The field paints its own root (scene overlays reach far past it); a component what its parts paint.
    const painted = id === "field" ? relBox(paint!.getBoundingClientRect(), own, ratio) : contentBox(paint!, own, ratio);
    return { id, w: painted.w, h: painted.h, dx: painted.x, dy: painted.y, cw: Math.max(own.width / ratio, painted.x + painted.w) };
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

/** The most the gap between columns, or between items in a column, opens to take up spare room (in gutters). */
const MAX_GAP = 3;

/** The largest scale at which `cols` fit the frame with at least one gutter between columns and between items. */
function scaleOf(cols: PackItem[][], frame: Box, gap: number): number {
  const across = (frame.w - gap * (cols.length - 1)) / cols.reduce((sum, col) => sum + Math.max(...col.map((item) => item.w)), 0);
  const down = Math.min(...cols.map((col) => (frame.h - gap * (col.length - 1)) / col.reduce((sum, item) => sum + item.h, 0)));
  return Math.min(MAX_SCALE, across, down);
}

/**
 * Slots of one packing at `scale`: columns side by side, items stacked in
 * each, left-aligned on the column. Spare room opens the gaps (up to
 * MAX_GAP gutters); what is left centres the whole, so nothing hangs in a
 * hollow cell.
 */
function slotsOf(cols: PackItem[][], frame: Box, gap: number, scale: number): Record<string, Box> {
  const widths = cols.map((col) => scale * Math.max(...col.map((item) => item.w)));
  const spareX = frame.w - widths.reduce((sum, w) => sum + w, 0) - gap * (cols.length - 1);
  const gapX = cols.length > 1 ? gap + Math.min(spareX / (cols.length - 1), gap * (MAX_GAP - 1)) : gap;
  const used = widths.reduce((sum, w) => sum + w, 0) + gapX * (cols.length - 1);
  let x = frame.x + (frame.w - used) / 2;
  const slots: Record<string, Box> = {};
  cols.forEach((col, c) => {
    const heights = col.map((item) => scale * item.h);
    const spareY = frame.h - heights.reduce((sum, h) => sum + h, 0) - gap * (col.length - 1);
    const gapY = col.length > 1 ? gap + Math.min(spareY / (col.length - 1), gap * (MAX_GAP - 1)) : gap;
    const tall = heights.reduce((sum, h) => sum + h, 0) + gapY * (col.length - 1);
    let y = frame.y + (frame.h - tall) / 2;
    col.forEach((item, k) => {
      slots[item.id] = { x, y, w: scale * item.w, h: heights[k]! };
      y += heights[k]! + gapY;
    });
    x += widths[c]! + gapX;
  });
  return slots;
}

/**
 * Packs the items into columns filling the wide canvas's frame: the given
 * columns (a chapter's composition, item ids), or else the 2–3 consecutive
 * columns that draw everything largest.
 */
export function packPoster(items: PackItem[], columns?: string[][], layout: HeroLayout = "wide"): Pack {
  const { margin, gutter: gap } = GRID[layout];
  const frame = { x: margin, y: margin, w: CANVAS[layout].w - 2 * margin, h: CANVAS[layout].h - 2 * margin };
  const byId = new Map(items.map((item) => [item.id, item]));
  const given = columns?.map((col) => col.flatMap((id) => byId.get(id) ?? []));
  const options = given && given.flat().length === items.length ? [given] : [2, 3].filter((k) => items.length >= k).flatMap((k) => partitions(items, k));
  const best = options.reduce<{ cols: PackItem[][]; scale: number } | null>((top, cols) => {
    const scale = scaleOf(cols, frame, gap);
    return !top || scale > top.scale ? { cols, scale } : top;
  }, null) ?? { cols: [items], scale: scaleOf([items], frame, gap) };
  return { scale: best.scale, slots: slotsOf(best.cols, frame, gap, best.scale), natural: Object.fromEntries(items.map((item) => [item.id, item])) };
}
