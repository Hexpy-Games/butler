import type { Box } from "../../heroTimeline";
import type { SketchBox } from "./Sketch";
import type { Marks, Measured } from "./types";

/** The first element down the first-child chain (at most four levels) that has a border radius, else the element. */
export function roundedWithin(element: HTMLElement): HTMLElement {
  let node: Element | null = element;
  for (let depth = 0; node && depth < 5; depth += 1, node = node.firstElementChild) {
    if (node instanceof HTMLElement && Number.parseFloat(getComputedStyle(node).borderTopLeftRadius) > 0) return node;
  }
  return element;
}

/** A box relative to `origin`, in canvas px (`ratio` = rendered px per canvas px). */
export function relBox(rect: DOMRect, origin: DOMRect, ratio: number): Box {
  return { x: (rect.left - origin.left) / ratio, y: (rect.top - origin.top) / ratio, w: Math.max(1, rect.width / ratio), h: Math.max(1, rect.height / ratio) };
}

type Rgba = [number, number, number, number];

function parse(value: string): Rgba | null {
  const match = /rgba?\(([^)]+)\)/u.exec(value);
  if (!match) return null;
  const parts = match[1]!.split(/[\s,/]+/u).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

/** The background actually behind an element: its own and its ancestors' fills, flattened. */
function backdrop(element: HTMLElement, root: HTMLElement): string {
  const layers: Rgba[] = [];
  for (let node: HTMLElement | null = element; node; node = node === root ? null : node.parentElement) {
    const fill = parse(getComputedStyle(node).backgroundColor);
    if (fill && fill[3] > 0) layers.push(fill);
    if (fill && fill[3] >= 0.99) break;
  }
  const page = parse(getComputedStyle(document.body).backgroundColor);
  let base: Rgba = page && page[3] > 0 ? page : [255, 255, 255, 1];
  for (const layer of layers.reverse()) base = over(layer, base);
  return `rgb(${base.slice(0, 3).map(Math.round).join(", ")})`;
}

function luminance(color: Rgba): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
}

/** WCAG contrast ratio of two rgb colors, to one decimal ("4.5"); "" if unreadable. */
export function contrast(fg: string, bg: string): string {
  const a = parse(fg);
  const b = parse(bg);
  if (!a || !b) return "";
  const [hi, lo] = [luminance(over(a, b)), luminance(b)].sort((x, y) => y - x) as [number, number];
  return ((hi + 0.05) / (lo + 0.05)).toFixed(1);
}

function shadowOf(value: string): Measured["shadow"] {
  if (!value || value === "none") return null;
  const numbers = value.replace(/rgba?\([^)]*\)/gu, "").match(/-?\d+(?:\.\d+)?px/gu)?.map((part) => Number.parseFloat(part)) ?? [];
  return numbers.length >= 3 ? { y: numbers[1]!, blur: numbers[2]! } : null;
}

/** The element a mark stands for: the one component inside it, or the mark itself around text. */
function markTarget(outer: HTMLElement): HTMLElement {
  const mark = outer.dataset.sweep !== undefined && outer.firstElementChild instanceof HTMLElement ? outer.firstElementChild : outer;
  const text = [...mark.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()));
  const only = mark.childElementCount === 1 && !text ? mark.firstElementChild : null;
  return only instanceof HTMLElement && only.getBoundingClientRect().width > 0 ? only : mark;
}

/** Every mark inside `container`, measured relative to it. */
export function measureMarks(container: HTMLElement, ratio: number, root: HTMLElement, base?: DOMRect, named: Record<string, string> = {}): Marks {
  const origin = base ?? container.getBoundingClientRect();
  const marks: Marks = {};
  // Marks are [data-a] wrappers, or DS-internal elements named by a selector.
  const found: Array<[string, HTMLElement]> = [
    ...[...container.querySelectorAll<HTMLElement>("[data-a]")].map((mark): [string, HTMLElement] => [mark.dataset.a!, markTarget(mark)]),
    ...Object.entries(named).flatMap(([name, selector]): Array<[string, HTMLElement]> => {
      const node = container.querySelector<HTMLElement>(selector);
      return node ? [[name, node]] : [];
    }),
  ];
  for (const [name, target] of found) {
    const rounded = roundedWithin(target);
    const style = getComputedStyle(target);
    const radius = Number.parseFloat(getComputedStyle(rounded).borderTopLeftRadius) || 0;
    const box = relBox(target.getBoundingClientRect(), origin, ratio);
    marks[name] = {
      box,
      r: Math.min(radius, box.w / 2, box.h / 2),
      pad: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map((value) => Number.parseFloat(value) || 0) as Measured["pad"],
      shadow: shadowOf(getComputedStyle(rounded).boxShadow),
      color: style.color,
      bg: backdrop(target, root),
    };
  }
  return marks;
}

/** Blueprint boxes of a container: the container, then each sketch mark's rounded element with its radius. */
export function measureSketch(container: HTMLElement, ratio: number, base?: DOMRect): SketchBox[] {
  const origin = base ?? container.getBoundingClientRect();
  const own = relBox(container.getBoundingClientRect(), origin, ratio);
  return [{ ...own, r: 0 }, ...[...container.querySelectorAll<HTMLElement>("[data-sketch]")].map((mark) => {
    const target = roundedWithin(markTarget(mark));
    const box = relBox(target.getBoundingClientRect(), origin, ratio);
    return { ...box, r: Math.min(Number.parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0, box.w / 2, box.h / 2) };
  })];
}
