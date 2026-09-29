import { CANVAS, type HeroLayout } from "./grid";
import { measureMarks, measureSketch, relBox, roundedWithin } from "./measure";
import { measureInk, measureView } from "./fitInk";
import { contentBox } from "./pack";
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
  // With a tall field scene, the scene (a prelude region) is what the prelude measures; the poster field only shows.
  const scene = layout === "tall" && Boolean(spec.fieldScene);
  const nodes = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)].filter((node) => !(scene && node.closest('[data-t="field-mover"]')));
  const origin = world.getBoundingClientRect();
  const ratio = origin.width / canvas.w;
  // Overlays inside the poster are positioned in its own (zoomed) px.
  const local = ratio * posterZoom(spec, layout);
  const panels: Geometry["panels"] = {};
  const sketches: Geometry["sketches"] = {};
  const cores: Geometry["cores"] = {};
  const marks: Geometry["marks"] = {};
  const panelOrder: Geometry["panelOrder"] = {};
  for (const build of spec.builds) {
    const panel = root.querySelector<HTMLElement>(`[data-panel="${build.id}"]`);
    if (!panel) return null;
    panels[build.id] = relBox(panel.getBoundingClientRect(), origin, ratio);
    // The component as drawn (not its stretched cell or tile): the blueprint's first box and what badges stand around.
    const surface = panel.querySelector<HTMLElement>(`[data-t="surface-${build.id}"]`) ?? panel;
    const core = contentBox(surface, panel.getBoundingClientRect(), local);
    cores[build.id] = core;
    const radius = Number.parseFloat(getComputedStyle(roundedWithin(surface.firstElementChild as HTMLElement ?? surface)).borderTopLeftRadius) || 0;
    sketches[build.id] = [{ ...core, r: Math.min(radius, core.h / 2) }, ...measureSketch(panel, local).slice(1)];
    marks[build.id] = measureMarks(panel, local, root, undefined, build.marks);
    panelOrder[build.id] = order(panel);
  }
  return {
    layout,
    canvas,
    boxes: Object.fromEntries(nodes("[data-m]").map((node) => [node.dataset.m!, relBox(node.getBoundingClientRect(), origin, ratio)])),
    boxCell: Object.fromEntries(nodes("[data-m]").flatMap((node) => {
      const cell = node.closest<HTMLElement>("[data-cell]")?.dataset.cell ?? (node.closest('[data-t="field-mover"]') ? "field" : undefined);
      return cell ? [[node.dataset.m!, cell]] : [];
    })),
    // A scope inside the poster (the field) is measured in the poster's own px, like the panels.
    scopes: Object.fromEntries(nodes("[data-mark-scope]").map((node) => [
      node.dataset.markScope!, measureMarks(node, node.closest('[data-t="field-mover"]') ? local : ratio, root),
    ])),
    lines: Object.fromEntries([...root.querySelectorAll<HTMLElement>("[data-roller]")].map((node) => [node.dataset.roller!, lineOf(node)])),
    field: relBox(field.getBoundingClientRect(), origin, ratio),
    view: measureView(root, origin, ratio) ?? undefined,
    ink: measureInk(root.querySelector<HTMLElement>('[data-t="poster"]') ?? world, origin, ratio) ?? undefined,
    panels,
    cores,
    sketches,
    marks,
    panelOrder,
    chars: Object.fromEntries([...root.querySelectorAll<HTMLElement>("[data-rv]")].map((node) => [node.dataset.rv!, [...(node.textContent ?? "").trim()].length])),
    sweeps: [...root.querySelectorAll<HTMLElement>("[data-sweep]")].map((node) => node.dataset.a!),
    fills: [...root.querySelectorAll<HTMLElement>("[data-fill]")].map((node) => node.dataset.a!),
  };
}
