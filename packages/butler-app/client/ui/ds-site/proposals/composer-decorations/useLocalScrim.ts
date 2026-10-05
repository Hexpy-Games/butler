import { useEffect, type RefObject } from "react";
import type { PulseMeter } from "./useTypingPulse";

/** Halo groups: the text block, the left controls (+ the preview line at rest), the right controls. */
export const SCRIM_POOL = 3;
/** Halo padding around each group (px): horizontal, vertical. The edge feathers out inside it. */
const PAD_X = 22;
const PAD_Y = 10;

function union(rects: DOMRect[]): DOMRect | null {
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

function textRects(root: Element): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(root);
  return [...range.getClientRects()].filter((rect) => rect.width >= 1 && rect.height >= 1);
}

/**
 * Local scrim: three frosted halos (TintedGlass tint + blur, feathered edges) placed only behind
 * the text block (union of its line boxes), the left controls and the right controls, so the
 * rest of the scene shows unmuted. A fixed pool of nodes, written once per frame (transform +
 * size) and only when a box changed; never on the input event itself.
 * - input: next frame re-reads the text block only (one Range over the editor).
 * - open/close and resizes: next frame also re-reads the control groups (cached, card-relative).
 * Layout is read only inside that frame, before any write.
 */
export function useLocalScrim(layer: RefObject<HTMLDivElement | null>, enabled: boolean, meter: RefObject<PulseMeter>) {
  useEffect(() => {
    const halos = layer.current;
    const card = halos?.closest("form");
    if (!card || !halos || !enabled) return undefined;
    let frame = 0;
    let full = true;
    let controls: { left: DOMRect | null; right: DOMRect | null } = { left: null, right: null };
    const written: string[] = [];
    const write = (index: number, box: DOMRect | null) => {
      const node = halos.children[index] as HTMLElement | undefined;
      if (!node) return;
      const key = box ? `${box.x}|${box.y}|${box.width}|${box.height}` : "";
      if (written[index] === key) return;
      written[index] = key;
      if (!box) { node.style.display = "none"; return; }
      node.style.display = "block";
      node.style.width = `${box.width + PAD_X * 2}px`;
      node.style.height = `${box.height + PAD_Y * 2}px`;
      node.style.transform = `translate(${box.x - PAD_X}px, ${box.y - PAD_Y}px)`;
    };
    const place = () => {
      frame = 0;
      const start = performance.now();
      const origin = card.getBoundingClientRect();
      const local = (rect: DOMRect | null) => rect && new DOMRect(rect.left - origin.left, rect.top - origin.top, rect.width, rect.height);
      const expanded = card.getAttribute("data-expanded") !== "false";
      let text: DOMRect[] = [];
      const editable = card.querySelector('[role="textbox"]');
      if (expanded && editable) {
        const placeholder = card.querySelector('[data-slot="composer-expanded-body"] [aria-hidden="true"]');
        text = editable.textContent ? textRects(editable) : placeholder ? textRects(placeholder) : [];
      }
      const preview = card.querySelector('[data-slot="composer-compact-preview"]');
      const previewLines = !expanded && preview ? textRects(preview) : [];
      const relayoutFrame = full;
      if (full) {
        const left: DOMRect[] = [];
        const right: DOMRect[] = [];
        const middle = origin.left + origin.width / 2;
        for (const control of card.querySelectorAll('[data-test-class="composer-toolbar"] button:not([data-slot="composer-compact-preview"])')) {
          const rect = control.getBoundingClientRect();
          if (rect.width > 0) (rect.left + rect.width / 2 < middle ? left : right).push(rect);
        }
        controls = { left: local(union(left)), right: local(union(right)) };
        full = false;
      }
      const leftParts = [...(controls.left ? [controls.left] : []), ...previewLines.map((rect) => local(rect)!)];
      write(0, local(union(text)));
      write(1, union(leftParts));
      write(2, controls.right);
      const samples = relayoutFrame ? meter.current.relayout : meter.current.scrim;
      samples.push(performance.now() - start);
      if (samples.length > 128) samples.shift();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    const relayout = () => { full = true; schedule(); };
    const resize = new ResizeObserver(relayout);
    resize.observe(card);
    const expanded = new MutationObserver(relayout);
    expanded.observe(card, { attributes: true, attributeFilter: ["data-expanded"] });
    card.addEventListener("input", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      expanded.disconnect();
      card.removeEventListener("input", schedule);
    };
  }, [layer, enabled, meter]);
}
