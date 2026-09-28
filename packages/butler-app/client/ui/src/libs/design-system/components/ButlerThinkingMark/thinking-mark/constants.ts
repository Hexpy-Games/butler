// Butler mark geometry in the 1200 x 1200 design space (matches the filled logo).
export const TAU = Math.PI * 2;
export const DESIGN_SIZE = 1200;
export const CENTER = DESIGN_SIZE / 2;
/** Radius of the two opposing ribbon sectors. */
export const RR = 329.43;
/** Half-angle of each ribbon sector. */
export const AL = Math.atan2(136, 300);
/** Corner rounding of the ribbon sectors. */
export const RHO = 34;
export const RING_R = 435;
export const RING_W = 74;

/** Radius of the lit "moon" sphere the bowtie rounds into. */
export const HS_R = 288;
/** Halftone cells live inside this disc (inside the ring). */
export const DISC_R = 392;
/**
 * The single spring that drives the whole morph (0 = logo, 1 = thinking form).
 * Every channel (outline, dot field, riso colour, motion clock) reads this one
 * progress, so idle -> thinking and back are one continuous transformation.
 * Critically damped (no overshoot, monotonic from rest); omega = sqrt(6) gives
 * ~0.7s to half and ~1.9s to 95%: a calm, unhurried morph.
 */
export const MORPH_SPRING = { k: 6, zeta: 1 } as const;
/**
 * Morph progress by which the motion clock reaches full speed. The motion starts
 * with the morph (frame one) but must not crawl for the whole calm morph: at 0.3
 * it is at full speed ~0.45s in (the pre-morph-rework pace), and the steady
 * thinking loop then runs at exactly its intended rate while the shape finishes.
 */
export const MOTION_FULL_SPEED_AT = 0.3;

export type SizeClass = 0 | 1 | 2;

export interface HalftonePreset {
  /** Screen pitch in design units. */
  pitch: number;
  /** Misregistration scale; small marks need a larger offset to read as colour. */
  mis: number;
  /** Paper grain strength at full morph (0 disables it). */
  grain: number;
}

// Index by size class: <20px, 20-63px, >=64px. All sizes print all three inks.
export const HALFTONE_PRESETS: readonly HalftonePreset[] = [
  { pitch: 100, mis: 2.6, grain: 0 },
  { pitch: 64, mis: 1.8, grain: 0 },
  { pitch: 25, mis: 1, grain: 0.18 },
];

/** Screen angles: key ink 45deg, riso blue 15deg, fluorescent pink 75deg. */
export const SCREEN_ANGLES = [Math.PI / 4, Math.PI / 12, (Math.PI * 5) / 12] as const;

export const RISO_MOTION = {
  /** Dot-size ripple amplitude. */
  wave: 0.2,
  /** Speed of the diagonal sweep that trades blue and pink. */
  sweep: 1.9,
  /** Light orbit: phi = phase + rate * T. */
  lightPhase: 2.3,
  lightRate: 1.1,
} as const;

/*
 * Simulation clock. Intrinsic to the canvas engine (not UI transition timing),
 * allowlisted in lint:motion (CANVAS_MOTION_ENGINES):
 * FRAME_INTERVAL_MS caps drawing at 60fps on high-refresh displays (2ms slack
 * for rAF jitter), MAX_STEP_S keeps the spring stable after a stalled frame,
 * SPRING_SUBSTEP_S is the spring integrator step.
 */
export const FRAME_INTERVAL_MS = 1000 / 60 - 2;
export const MAX_STEP_S = 0.05;
export const SPRING_SUBSTEP_S = 0.005;

export const GRAIN_TILE = 128;
