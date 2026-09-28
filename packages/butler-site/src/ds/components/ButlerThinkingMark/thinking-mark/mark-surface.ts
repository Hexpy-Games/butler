import type { RisoInks } from "../butlerMarkTheme";
import { GRAIN_TILE, RHO, type SizeClass } from "./constants";
import { createFrameParams, latticeFor, type FrameParams, type HalftoneLayer } from "./halftone-model";
import { createRand } from "./motion";
import { sizeClass, traceRibbon } from "./ribbon-geometry";

export type Ctx = CanvasRenderingContext2D;

/** Per-instance drawing context: the visible canvas plus its offscreen layers. */
export interface MarkSurface {
  ctx: Ctx;
  ink: string;
  riso: RisoInks;
  px: number;
  k: number;
  cls: SizeClass;
  layers: HalftoneLayer[];
  params: FrameParams;
  lctx: Ctx;
  rctx: Ctx;
  mctx: Ctx;
  grain: HTMLCanvasElement | null;
  rand: () => number;
}

function offscreen(): Ctx {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("2d canvas unavailable");
  return context;
}

export function createSurface(ctx: Ctx, ink: string, riso: RisoInks): MarkSurface {
  return {
    ctx, ink, riso, px: 0, k: 0, cls: 0, layers: latticeFor(0), params: createFrameParams(),
    lctx: offscreen(), rctx: offscreen(), mctx: offscreen(), grain: null, rand: createRand(20260925),
  };
}

function buildGrain(rand: () => number) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = GRAIN_TILE;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const image = context.createImageData(GRAIN_TILE, GRAIN_TILE);
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = rand() < 0.5 ? Math.round(rand() * 255) : 0;
  context.putImageData(image, 0, 0);
  return canvas;
}

/** Sizes every layer to `px` device pixels and rebuilds the solid logo (not called per frame). */
export function resizeSurface(s: MarkSurface, px: number, k: number, cssSize: number) {
  s.px = px;
  s.k = k;
  s.cls = sizeClass(cssSize);
  s.layers = latticeFor(s.cls);
  for (const context of [s.ctx, s.lctx, s.rctx, s.mctx]) {
    if (context.canvas.width !== px) context.canvas.width = context.canvas.height = px;
  }
  if (s.cls === 2 && !s.grain) s.grain = buildGrain(s.rand);
  const r = s.rctx;
  r.setTransform(1, 0, 0, 1, 0, 0);
  r.clearRect(0, 0, px, px);
  r.setTransform(k, 0, 0, k, 0, 0);
  r.fillStyle = r.strokeStyle = s.ink;
  r.lineJoin = "round";
  r.lineWidth = RHO * 2;
  traceRibbon(r);
  r.fill();
  r.stroke();
}
