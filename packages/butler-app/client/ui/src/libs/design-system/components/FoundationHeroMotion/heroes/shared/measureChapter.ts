import { CANVAS, type HeroLayout } from "./grid";
import { measureMarks, measureSketch, relBox } from "./measure";
import { posterZoom } from "./timeline";
import type { ChapterSpec, Geometry } from "./types";

function lineOf(element: Element): number {
  const style = getComputedStyle(element);
  return Number.parseFloat(style.lineHeight) || (Number.parseFloat(style.fontSize) || 12) * 1.2;
}

/** Reveal names and part names inside `container`, in reading order (badges and notes excluded). */
function order(container: Element): Array<{ name: string; part: boolean }> {
  return [...container.querySelectorAll<HTMLElement>("[data-rv], [data-part]")]
    .filter((node) => !node.closest("[data-annots]"))
    .map((node) => (node.dataset.part ? { name: node.dataset.part, part: true } : { name: node.dataset.rv!, part: false }));
}

/**
 * Reads the poster layout (no animation applied) in canvas px: boxes are
 * taken relative to the world and divided by the stage's fit scale, so they
 * hold at any stage size. Returns null until everything is laid out.
 */
export function measureChapter(root: HTMLElement, layout: HeroLayout, spec: ChapterSpec): Geometry | null {
  const world = root.querySelector<HTMLElement>('[data-t="world"]');
  const field = root.querySelector<HTMLElement>('[data-t="field-mover"]');
  if (!world || !field || world.offsetWidth === 0) return null;
  const canvas = CANVAS[layout];
  const origin = world.getBoundingClientRect();
  const ratio = origin.width / canvas.w;
  // Overlays inside the poster are positioned in its own (zoomed) px.
  const local = ratio * posterZoom(spec, layout);
  const panels: Geometry["panels"] = {};
  const sketches: Geometry["sketches"] = {};
  const marks: Geometry["marks"] = {};
  const panelOrder: Geometry["panelOrder"] = {};
  for (const build of spec.builds) {
    const panel = root.querySelector<HTMLElement>(`[data-panel="${build.id}"]`);
    if (!panel) return null;
    panels[build.id] = relBox(panel.getBoundingClientRect(), origin, ratio);
    sketches[build.id] = measureSketch(panel, local);
    marks[build.id] = measureMarks(panel, local, root, undefined, build.marks);
    panelOrder[build.id] = order(panel);
  }
  return {
    layout,
    canvas,
    boxes: Object.fromEntries([...root.querySelectorAll<HTMLElement>("[data-m]")].map((node) => [node.dataset.m!, relBox(node.getBoundingClientRect(), origin, ratio)])),
    lines: Object.fromEntries([...root.querySelectorAll<HTMLElement>("[data-roller]")].map((node) => [node.dataset.roller!, lineOf(node)])),
    field: relBox(field.getBoundingClientRect(), origin, ratio),
    panels,
    sketches,
    marks,
    panelOrder,
    chars: Object.fromEntries([...root.querySelectorAll<HTMLElement>("[data-rv]")].map((node) => [node.dataset.rv!, [...(node.textContent ?? "").trim()].length])),
    sweeps: [...root.querySelectorAll<HTMLElement>("[data-sweep]")].map((node) => node.dataset.a!),
    fills: [...root.querySelectorAll<HTMLElement>("[data-fill]")].map((node) => node.dataset.a!),
  };
}
