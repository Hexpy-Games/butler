import type { RisoInk } from "../butlerMarkTheme";
import { CENTER, GRAIN_TILE, HALFTONE_PRESETS, RING_R, RING_W, TAU } from "./constants";
import { dotRadius, renderMode, setFrameParams, type FrameParams, type HalftoneLayer } from "./halftone-model";
import { clipMargin, OUTLINE_RAYS, traceOutline } from "./morph-outline";
import { progressOf, type MorphSim } from "./motion";
import type { Ctx, MarkSurface } from "./mark-surface";

export { createSurface, resizeSurface, type MarkSurface } from "./mark-surface";

function clearMain(s: MarkSurface) {
  const c = s.ctx;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = "source-over";
  c.globalAlpha = 1;
  c.clearRect(0, 0, s.px, s.px);
}

export function drawRing(s: MarkSurface) {
  const c = s.ctx;
  c.setTransform(s.k, 0, 0, s.k, 0, 0);
  c.globalAlpha = 1;
  c.strokeStyle = s.ink;
  c.lineWidth = RING_W;
  c.beginPath();
  c.arc(CENTER, CENTER, RING_R, 0, TAU);
  c.stroke();
}

/** The exact filled logo: fused bowtie + ring. */
export function drawRest(s: MarkSurface, alpha = 1) {
  clearMain(s);
  s.ctx.globalAlpha = alpha;
  s.ctx.drawImage(s.rctx.canvas, 0, 0);
  drawRing(s);
}

function drawHalftoneInk(c: Ctx, L: HalftoneLayer, ink: number, offx: number, offy: number, p: FrameParams) {
  c.beginPath();
  for (let i = 0; i < L.N; i += 1) {
    const r = dotRadius(L, i, ink, p);
    if (r <= 0) continue;
    const x = L.X[i] + offx;
    const y = L.Y[i] + offy;
    c.moveTo(x + r, y);
    c.arc(x, y, r, 0, TAU);
  }
  c.fill();
}

function setInk(c: Ctx, ink: RisoInk) {
  c.fillStyle = ink.color;
  c.globalAlpha = ink.alpha;
}

/**
 * The dots are clipped to the morphing outline itself (traced from the same progress), so at
 * rest they are fused and trimmed to the exact logo, and as the morph runs the clip moves
 * with the shape and opens by clipMargin until the edge is whole dots; then it is released.
 */
function clipToOutline(s: MarkSurface, g: number, pitch: number) {
  const margin = clipMargin(g, pitch);
  if (!Number.isFinite(margin)) return;
  traceOutline(g, s.params.br, s.outline);
  const x = s.mctx;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, s.px, s.px);
  x.setTransform(s.k, 0, 0, s.k, 0, 0);
  x.fillStyle = x.strokeStyle = s.ink;
  x.lineJoin = "round";
  x.beginPath();
  for (let a = 0; a < OUTLINE_RAYS; a += 1) {
    const angle = (a / OUTLINE_RAYS) * TAU;
    const r = s.outline[a] ?? 0;
    if (a === 0) x.moveTo(CENTER + r, CENTER);
    else x.lineTo(CENTER + Math.cos(angle) * r, CENTER + Math.sin(angle) * r);
  }
  x.closePath();
  x.fill();
  if (margin > 0) {
    x.lineWidth = 2 * margin;
    x.stroke();
  }
  const l = s.lctx;
  l.setTransform(1, 0, 0, 1, 0, 0);
  l.globalAlpha = 1;
  l.globalCompositeOperation = "destination-in";
  l.drawImage(x.canvas, 0, 0);
  l.globalCompositeOperation = "source-over";
}

function grainOver(s: MarkSurface, alpha: number) {
  if (!s.grain || alpha < 0.005) return;
  const l = s.lctx;
  l.setTransform(1, 0, 0, 1, 0, 0);
  l.globalCompositeOperation = "destination-out";
  l.globalAlpha = alpha;
  const ox = -Math.floor(s.rand() * GRAIN_TILE);
  const oy = -Math.floor(s.rand() * GRAIN_TILE);
  for (let y = oy; y < s.px; y += GRAIN_TILE) for (let x = ox; x < s.px; x += GRAIN_TILE) l.drawImage(s.grain, x, y);
  l.globalCompositeOperation = "source-over";
  l.globalAlpha = 1;
}

export function renderHalftone(s: MarkSurface, sim: MorphSim) {
  const M = progressOf(sim.M.x);
  const T = sim.T;
  const p = s.params;
  const preset = HALFTONE_PRESETS[s.cls] ?? HALFTONE_PRESETS[2];
  const [key, blue, pink] = s.layers;
  if (!preset || !key || !blue || !pink) return;
  setFrameParams(p, M, T, s.cls);
  clearMain(s);
  const l = s.lctx;
  l.setTransform(1, 0, 0, 1, 0, 0);
  l.globalCompositeOperation = "source-over";
  l.globalAlpha = 1;
  l.clearRect(0, 0, s.px, s.px);
  l.setTransform(s.k, 0, 0, s.k, 0, 0);
  if (M > 0.001) {
    // misregistration opens with the morph: the inks start in register on the key dots
    const mis = (7 + 4 * Math.sin(T * 1.2)) * preset.mis * M;
    const mis2 = (-5 + 3 * Math.cos(T * 0.95)) * preset.mis * M;
    setInk(l, s.riso.blue);
    drawHalftoneInk(l, blue, 1, mis, mis2, p);
    setInk(l, s.riso.pink);
    drawHalftoneInk(l, pink, 2, -mis2, mis * 0.6, p);
  }
  l.fillStyle = s.ink;
  l.globalAlpha = 1;
  drawHalftoneInk(l, key, 0, 0, 0, p);
  grainOver(s, preset.grain * M);
  clipToOutline(s, M, preset.pitch);
  s.ctx.drawImage(l.canvas, 0, 0);
  drawRing(s);
}

/** Draws one frame; returns nothing and never allocates. */
export function drawFrame(s: MarkSurface, sim: MorphSim, reduced: boolean) {
  const mode = renderMode(sim, reduced);
  // Reduced motion draws the still logo; the breathe is a CSS opacity loop on the canvas.
  if (mode === "reduced" || mode === "rest") drawRest(s);
  else renderHalftone(s, sim);
  const canvas = s.ctx.canvas as HTMLCanvasElement;
  if (canvas.dataset.markState !== "painted") canvas.dataset.markState = "painted";
}
