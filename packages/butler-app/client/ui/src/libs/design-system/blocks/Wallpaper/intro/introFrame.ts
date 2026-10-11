// Draws one intro frame at reveal time t: the canvas geometry, the card and mark slot from the shell, the wake looks.
import { restWallpaperPrintFrame } from "../glPrint";
import type { WallpaperCanvasBox } from "../measure";
import type { WallpaperScene } from "../registry";
import type { WallpaperRenderer } from "../renderer";
import { wallpaperCanvasSize } from "../scheduler";
import type { WallpaperContentRect } from "../types";
import { introUniforms } from "./introParams";
import type { WallpaperIntroLayout } from "./introTimeline";
import type { IntroWake } from "./introWake";

/** Buffer: DPR at most 1.5 and 1.6 MP (1.0 MP on touch), as the approved prototype. */
const INTRO_BUDGET = { maxFps: 0, maxPixelRatio: 1.5, maxPixels: 1_600_000 };
const INTRO_TOUCH_PIXELS = 1_000_000;

type Rect = readonly [number, number, number, number];

/** A client rect in the canvas (CSS px). */
export function introLocalRect(rect: WallpaperContentRect, box: WallpaperCanvasBox): Rect {
  return [rect.x - box.left, rect.y - box.top, rect.width, rect.height];
}

/** The canvas moved or resized by more than half a pixel since `drawn` (none drawn yet: true). */
export function introBoxMoved(drawn: WallpaperCanvasBox | null, box: WallpaperCanvasBox): boolean {
  if (!drawn) return true;
  return Math.abs(drawn.width - box.width) + Math.abs(drawn.height - box.height) + Math.abs(drawn.left - box.left) + Math.abs(drawn.top - box.top) > 0.5;
}

/** The riso print edition: the scene paper param when it has one (night or day), else its tone. */
function night(scene: WallpaperScene): boolean {
  const paper = scene.values.paper;
  return paper === undefined ? scene.dark : paper === "night";
}

export function drawIntroFrame(renderer: WallpaperRenderer, scene: WallpaperScene, box: WallpaperCanvasBox, layout: WallpaperIntroLayout | null, wake: IntroWake, t: number): boolean {
  // Before the shell measures: a 420 px card at the 20% top rule, its mark slot at the top.
  const card = layout ? introLocalRect(layout.card, box) : [box.width / 2 - 210, box.height * 0.2, 420, 344] as const;
  const slot = layout?.slot ? { x: layout.slot.x - box.left, y: layout.slot.y - box.top } : { x: card[0] + card[2] / 2, y: card[1] + 56 };
  const looks = wake.looks();
  const budget = box.coarse ? { ...INTRO_BUDGET, maxPixels: INTRO_TOUCH_PIXELS } : INTRO_BUDGET;
  const size = wallpaperCanvasSize(box, window.devicePixelRatio || 1, budget);
  const uniforms = introUniforms(t, { width: box.width, height: box.height, card: looks.card ?? card, slot }, { beat: looks.pulse, stir: looks.stir, night: night(scene) });
  return renderer.drawIntro({ ...size, timeMs: 0, dayPhase: 0, seed: 0, print: restWallpaperPrintFrame([box.width, box.height]) }, uniforms);
}
