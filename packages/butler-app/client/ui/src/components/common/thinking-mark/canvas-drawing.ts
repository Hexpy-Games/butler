import type { RisoInk } from "../butlerMarkTheme.ts";
import { CENTER, GRAIN_TILE, HALFTONE_PRESETS, REDUCED_MOTION, RHO, RING_R, RING_W, TAU } from "./constants";
import { dotRadius, renderMode, setFrameParams, type FrameParams, type HalftoneLayer } from "./halftone-model";
import { clamp, ease, type MorphSim } from "./motion";
import { traceRibbon } from "./ribbon-geometry";
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

/** Reduced motion: the filled logo with a gentle opacity breathe while working. */
export function drawReduced(s: MarkSurface, sim: MorphSim) {
  drawRest(s, 1 - sim.rm * (0.42 + 0.08 * Math.sin((sim.clock * TAU) / REDUCED_MOTION.period)));
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

/** At rest the dots are fused and clipped to the exact logo; the clip dilates away as they granulate. */
function maskDilated(s: MarkSurface, M: number) {
  const d = 720 * ease(clamp(M * 2.5, 0, 1));
  if (d > 700) return;
  const x = s.mctx;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, s.px, s.px);
  x.setTransform(s.k, 0, 0, s.k, 0, 0);
  x.fillStyle = x.strokeStyle = s.ink;
  x.lineJoin = "round";
  traceRibbon(x);
  x.fill();
  x.lineWidth = RHO * 2 + 2 * d;
  x.stroke();
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
  const M = sim.M.x;
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
    const mis = (7 + 4 * Math.sin(T * 1.2)) * preset.mis;
    const mis2 = (-5 + 3 * Math.cos(T * 0.95)) * preset.mis;
    setInk(l, s.riso.blue);
    drawHalftoneInk(l, blue, 1, mis, mis2, p);
    setInk(l, s.riso.pink);
    drawHalftoneInk(l, pink, 2, -mis2, mis * 0.6, p);
  }
  l.fillStyle = s.ink;
  l.globalAlpha = 1;
  drawHalftoneInk(l, key, 0, 0, 0, p);
  grainOver(s, preset.grain * clamp(M, 0, 1));
  maskDilated(s, M);
  s.ctx.drawImage(l.canvas, 0, 0);
  drawRing(s);
}

/** Draws one frame; returns nothing and never allocates. */
export function drawFrame(s: MarkSurface, sim: MorphSim, reduced: boolean) {
  const mode = renderMode(sim, reduced);
  if (mode === "reduced") drawReduced(s, sim);
  else if (mode === "rest") drawRest(s);
  else renderHalftone(s, sim);
}
