import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { TURN } from "./layersView";
import s from "./LayersHero.module.css";

/** A component's silhouette on its sheet, in sheet px (x, y, w, h and the corner radius). */
export interface Ext {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

/** Length of a computed `translate` part ("-50%" of the element's own size, or px). */
function length(part: string | undefined, size: number): number {
  if (!part) return 0;
  return part.endsWith("%") ? (Number.parseFloat(part) / 100) * size : Number.parseFloat(part) || 0;
}

/** Where a component sits on its plane, from layout alone (offsets ignore transforms, so the camera can be anywhere), adding back its own translate. */
function boxIn(el: HTMLElement, plane: HTMLElement): Ext {
  let x = 0;
  let y = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== plane) {
    const cs = getComputedStyle(cur);
    const [tx, ty] = cs.translate && cs.translate !== "none" ? cs.translate.split(" ") : [];
    const m = cs.transform && cs.transform !== "none" ? new DOMMatrix(cs.transform) : null;
    x += cur.offsetLeft + length(tx, cur.offsetWidth) + (m?.e ?? 0);
    y += cur.offsetTop + length(ty, cur.offsetHeight) + (m?.f ?? 0);
    const parent = cur.offsetParent as HTMLElement | null;
    if (parent && parent !== plane) {
      x += parent.clientLeft;
      y += parent.clientTop;
    }
    cur = parent;
  }
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const r = Math.min(Number.parseFloat(getComputedStyle(el).borderBottomRightRadius) || 0, w / 2, h / 2);
  return { x, y, w, h, r };
}

/** The components of every sheet (marked `data-ext`; the page's is the window itself), measured on the layout so the extrusions follow their real shapes. */
export function useExtrusions(ref: RefObject<HTMLElement | null>, live: boolean) {
  const [boxes, setBoxes] = useState<Ext[][]>([]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!live || !root) return undefined;
    const measure = () => {
      const next = [...root.querySelectorAll<HTMLElement>(":scope > [data-sheet]")].map((sheet, k) => {
        const plane = sheet.querySelector<HTMLElement>("[data-plane]");
        if (k === 0) return [{ x: 0, y: 0, w: root.offsetWidth, h: root.offsetHeight, r: Number.parseFloat(getComputedStyle(root).getPropertyValue("--app-window-radius")) || 0 }];
        return plane ? [...plane.querySelectorAll<HTMLElement>("[data-ext]")].map((el) => { const b = boxIn(el, plane); return { ...b, x: b.x + plane.offsetLeft, y: b.y + plane.offsetTop }; }) : [];
      });
      setBoxes((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    void document.fonts?.ready.then(measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(root);
    return () => observer?.disconnect();
  }, [ref, live]);
  return boxes;
}

/** Thickness of the components' edge, in sheet px (the window's own, or the phone's). */
const SLAB = { wide: 9, tall: 14 } as const;
/** How many hard steps make the edge (each about a screen px, so the curve round a corner reads smooth). */
const EDGE_STEPS = 10;

/**
 * A component's thickness: its empty silhouette (its size and corner radius) copied, a px at a time, along the
 * sheet's own plane to where its depth lands on the frame at the quarter view: the projection of "straight down
 * z" back onto the sheet (rx, rz of the camera), so the edge follows every rounded corner as one smooth curve.
 * One element per component, no depth layers of its own.
 */
export function Slab({ k, box, compact }: { k: number; box: Ext; compact: boolean }) {
  const layout = compact ? "tall" : "wide";
  const { rx, rz } = TURN[layout];
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dy = SLAB[layout] * Math.tan(rad(rx)) * Math.cos(rad(rz));
  const dx = dy * Math.tan(rad(rz));
  const edge = Array.from({ length: EDGE_STEPS }, (_, i) => `${((i + 1) / EDGE_STEPS) * dx}px ${((i + 1) / EDGE_STEPS) * dy}px 0 var(--slab-tone)`).join(", ");
  const style = { "--x": `${box.x}px`, "--y": `${box.y}px`, "--w": `${box.w}px`, "--h": `${box.h}px`, "--r": `${box.r}px`, boxShadow: edge } as CSSProperties;
  return <span className={s.copy} data-t={`slab-${k}`} style={style} />;
}
