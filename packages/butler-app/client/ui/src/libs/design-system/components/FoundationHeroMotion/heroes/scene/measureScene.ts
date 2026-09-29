import { CANVAS, type HeroLayout } from "../shared/grid";
import { measureInk, measureView } from "../shared/fitInk";
import { measureMarks, relBox } from "../shared/measure";
import type { SceneGeometry } from "./types";

function lineOf(element: Element): number {
  const style = getComputedStyle(element);
  return Number.parseFloat(style.lineHeight) || (Number.parseFloat(style.fontSize) || 12) * 1.2;
}

/**
 * Reads the static layout (no animation applied) in canvas px: boxes are
 * taken relative to the world and divided by the stage's fit scale, so they
 * hold at any stage size. Returns null until laid out.
 */
export function measureScene(root: HTMLElement, layout: HeroLayout): SceneGeometry | null {
  const world = root.querySelector<HTMLElement>('[data-t="world"]');
  if (!world || world.offsetWidth === 0) return null;
  const canvas = CANVAS[layout];
  const origin = world.getBoundingClientRect();
  const ratio = origin.width / canvas.w;
  const all = (selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];
  const box = (node: Element) => relBox(node.getBoundingClientRect(), origin, ratio);
  return {
    layout,
    canvas,
    boxes: Object.fromEntries(all("[data-m]").map((node) => [node.dataset.m!, box(node)])),
    boxCell: Object.fromEntries(all("[data-m]").flatMap((node) => {
      const cell = node.closest<HTMLElement>("[data-cell]")?.dataset.cell;
      return cell ? [[node.dataset.m!, cell]] : [];
    })),
    scopes: Object.fromEntries(all("[data-mark-scope]").map((node) => [node.dataset.markScope!, measureMarks(node, ratio, root)])),
    lines: Object.fromEntries(all("[data-roller]").map((node) => [node.dataset.roller!, lineOf(node)])),
    chars: Object.fromEntries(all("[data-rv]").map((node) => [node.dataset.rv!, [...(node.textContent ?? "").trim()].length])),
    tiles: Object.fromEntries(all("[data-tile]").map((node) => [node.dataset.tile!, box(node)])),
    view: measureView(root, origin, ratio) ?? undefined,
    ink: measureInk(root.querySelector<HTMLElement>('[data-t="poster"]') ?? world, origin, ratio) ?? undefined,
  };
}
