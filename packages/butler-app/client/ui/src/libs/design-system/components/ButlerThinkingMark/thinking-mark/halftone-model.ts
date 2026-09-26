import {
  CENTER,
  DISC_R,
  HALFTONE_PRESETS,
  HS_R,
  RISO_MOTION,
  SCREEN_ANGLES,
  type SizeClass,
} from "./constants";
import { clamp, ease, mLocal, type MorphSim } from "./motion";
import { sdRibbon } from "./ribbon-geometry";

/** One halftone screen: fixed cells with precomputed ribbon SDF, emboss and sphere normals. */
export interface HalftoneLayer {
  N: number;
  pitch: number;
  X: Float32Array;
  Y: Float32Array;
  SR: Float32Array;
  DC: Float32Array;
  NRX: Float32Array;
  NRY: Float32Array;
  NRZ: Float32Array;
  NSX: Float32Array;
  NSY: Float32Array;
  NSZ: Float32Array;
}

const LAYER_KEYS = ["X", "Y", "SR", "DC", "NRX", "NRY", "NRZ", "NSX", "NSY", "NSZ"] as const;
const embossHeight = (x: number, y: number) => Math.sqrt(clamp(-sdRibbon(x, y) / 120, 0, 1));

function buildLayer(angle: number, pitch: number): HalftoneLayer {
  const cols: Record<(typeof LAYER_KEYS)[number], number[]> = {
    X: [], Y: [], SR: [], DC: [], NRX: [], NRY: [], NRZ: [], NSX: [], NSY: [], NSZ: [],
  };
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const e = 8;
  for (let v = -440; v <= 440; v += pitch) {
    for (let u = -440; u <= 440; u += pitch) {
      const x = CENTER + u * ca - v * sa;
      const y = CENTER + u * sa + v * ca;
      const dc = Math.hypot(x - CENTER, y - CENTER);
      if (dc > DISC_R) continue;
      const hx = ((embossHeight(x + e, y) - embossHeight(x - e, y)) / (2 * e)) * 120;
      const hy = ((embossHeight(x, y + e) - embossHeight(x, y - e)) / (2 * e)) * 120;
      const nl = Math.hypot(hx, hy, 1);
      const sx = (x - CENTER) / HS_R;
      const sy = (y - CENTER) / HS_R;
      const sz = Math.sqrt(Math.max(0.02, 1 - sx * sx - sy * sy));
      const sl = Math.hypot(sx, sy, sz);
      cols.X.push(x); cols.Y.push(y); cols.SR.push(sdRibbon(x, y)); cols.DC.push(dc);
      cols.NRX.push(-hx / nl); cols.NRY.push(-hy / nl); cols.NRZ.push(1 / nl);
      cols.NSX.push(sx / sl); cols.NSY.push(sy / sl); cols.NSZ.push(sz / sl);
    }
  }
  const layer = { N: cols.X.length, pitch } as HalftoneLayer;
  for (const key of LAYER_KEYS) layer[key] = Float32Array.from(cols[key]);
  return layer;
}

/** Builds the three screens (key, riso blue, fluorescent pink) for a size class. */
export function buildHalftone(cls: SizeClass): HalftoneLayer[] {
  const pitch = HALFTONE_PRESETS[cls]?.pitch ?? 25;
  return SCREEN_ANGLES.map((angle) => buildLayer(angle, pitch));
}

const LATTICES: Partial<Record<SizeClass, HalftoneLayer[]>> = {};

/** Lattices are built once per size class and shared by every mark. */
export function latticeFor(cls: SizeClass) {
  return (LATTICES[cls] ??= buildHalftone(cls));
}

/** Per-frame parameters, one reused object per mark (no allocation in the hot loop). */
export interface FrameParams {
  M: number;
  T: number;
  e: number;
  lx: number;
  ly: number;
  lz: number;
  br: number;
}

export function createFrameParams(): FrameParams {
  return { M: 0, T: 0, e: 0, lx: 0, ly: 0, lz: 1, br: 1 };
}

export function setFrameParams(p: FrameParams, M: number, T: number, _cls: SizeClass) {
  p.M = M;
  p.T = T;
  p.e = Math.min(1, M * 4);
  p.br = 1 + 0.025 * Math.sin(T * 1.3);
  // riso moon: the light orbits briskly with a gentle bob
  const phi = RISO_MOTION.lightPhase + RISO_MOTION.lightRate * T;
  const el = 0.95 + 0.18 * Math.sin(T * 0.9);
  p.lx = Math.cos(phi) * Math.sin(el);
  p.ly = Math.sin(phi) * Math.sin(el) * 0.85;
  p.lz = Math.cos(el);
}

/** Moon tone: one Lambert term plus a small specular, on normals blended emboss -> sphere. */
export function htTone(L: HalftoneLayer, i: number, m: number, p: FrameParams) {
  let nx = L.NRX[i] + (L.NSX[i] - L.NRX[i]) * m;
  let ny = L.NRY[i] + (L.NSY[i] - L.NRY[i]) * m;
  let nz = L.NRZ[i] + (L.NSZ[i] - L.NRZ[i]) * m;
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  nx /= nl; ny /= nl; nz /= nl;
  const lam = Math.max(0, nx * p.lx + ny * p.ly + nz * p.lz);
  const hz = nz * 0.5 + 0.5 * p.lz;
  const spec = Math.pow(Math.max(0, nx * p.lx * 0.5 + ny * p.ly * 0.5 + hz), 16) * 0.25;
  return clamp(0.1 + 0.9 * lam + spec, 0, 1);
}

/** Dot radius (design units) for cell i on screen `ink` (0 key, 1 blue, 2 pink); 0 = no dot. */
export function dotRadius(L: HalftoneLayer, i: number, ink: number, p: FrameParams) {
  const pitch = L.pitch;
  const dc = L.DC[i];
  const m = mLocal(p.M, dc / 400);
  const gr = ease(clamp(m / 0.3, 0, 1));
  const sd = L.SR[i] + (dc - HS_R * p.br - L.SR[i]) * m;
  const mask = clamp(0.5 - sd / (pitch * 0.7) + 0.7 * (1 - gr), 0, 1);
  if (mask < 0.01) return 0;
  const tone = htTone(L, i, m, p);
  const s = p.e * (0.35 + 0.65 * m);
  // a ripple of dot size travelling outward, and a diagonal sweep that trades blue and pink
  const ripple = 1 + RISO_MOTION.wave * m * Math.sin(dc / 46 - p.T * 3.1);
  let cov: number;
  if (ink === 0) {
    cov = mask * (1 + (tone - 1) * s) * ripple;
  } else {
    const sw = 0.5 + 0.5 * Math.sin((L.X[i] * 0.72 + L.Y[i] * 0.69) / 150 - p.T * RISO_MOTION.sweep);
    cov = mask * (1 - tone) * 0.9 * s * (ink === 1 ? 1 - sw : sw) * ripple;
  }
  if (cov < 0.004) return 0;
  return pitch * (0.8 + (0.64 - 0.8) * gr) * Math.sqrt(Math.min(cov, 1.25));
}

export type RenderMode = "rest" | "reduced" | "halftone";

export function renderMode(sim: MorphSim, reduced: boolean): RenderMode {
  if (reduced) return "reduced";
  return sim.idle ? "rest" : "halftone";
}
