import type { Box } from "../../heroTimeline";
import { paints, shows } from "./pack";
import { relBox } from "./measure";

/**
 * What the finished poster really paints (text glyph runs, fills, borders,
 * icons, and the badges and notes beside the components), as one box in
 * canvas px, relative to `origin` (the world). The finale frames this box, so
 * the poster's own overflow (a note past its component, a tag in the gutter)
 * counts and nothing ends up touching an edge.
 */
export function measureInk(poster: HTMLElement, origin: DOMRect, ratio: number): Box | null {
  const rects: DOMRect[] = [];
  const add = (rect: DOMRect) => {
    if (rect.width > 0 && rect.height > 0) rects.push(rect);
  };
  for (const node of poster.querySelectorAll("*")) {
    if (node instanceof SVGElement && !(node instanceof SVGSVGElement)) continue;
    if (!shows(node, poster)) continue;
    for (const child of node.childNodes) {
      if (child.nodeType !== Node.TEXT_NODE || !(child.textContent ?? "").trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(child);
      for (const rect of range.getClientRects()) add(rect);
    }
    if (node instanceof SVGSVGElement || (!(node instanceof SVGElement) && paints(node) && ![...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim()))) add(node.getBoundingClientRect());
  }
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return relBox(new DOMRect(left, top, right - left, bottom - top), origin, ratio);
}

/** The stage's visible part of the canvas (a wide stage covers its canvas, so the top and bottom may be cropped), in canvas px. */
export function measureView(root: HTMLElement, origin: DOMRect, ratio: number): Box | null {
  const stage = root.parentElement;
  return stage ? relBox(stage.getBoundingClientRect(), origin, ratio) : null;
}
