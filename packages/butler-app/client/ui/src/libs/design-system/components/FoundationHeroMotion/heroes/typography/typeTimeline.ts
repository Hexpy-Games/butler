/**
 * The Typography hero's timeline, as fractions of one cycle (--type-cycle, 60
 * beats). The keyframes in TypographyHero.module.css use the same marks:
 *
 *   0–30%   Typeface     the specimen sweeps the weight axis, a readout tracks it
 *   30–56%  Scale        the role ladder builds, sizes and leading align right
 *   56–100% Composition  a uniform paragraph resolves into hierarchy, leading
 *                        guides show and recede, tabular digits roll in place
 */

/** Weight stops of the sweep: from the brand weight down to the thinnest, up to the heaviest, back. */
export const SWEEP = [620, 500, 380, 260, 150, 45, 150, 260, 380, 500, 620, 740, 850, 920, 850, 740, 620];
/** Where the sweep starts and how long each stop lasts. */
export const SWEEP_START = 0.04;
export const SWEEP_STEP = 0.008;
/** The axis the readout ranges over (the official @font-face range). */
export const AXIS_MIN = 45;
export const AXIS_MAX = 920;

/** Ladder rows enter one after another from here. */
export const LADDER_START = 0.31;
export const LADDER_STAGGER = 0.015;

/** Cycle fraction at which the k-th sweep stop begins (stop 0 shows from the scene's start). */
export function sweepAt(k: number): number {
  return k === 0 ? 0 : SWEEP_START + (k - 1) * SWEEP_STEP;
}

/** Axis position (0..1) of a weight. */
export function axisPosition(weight: number): number {
  return (weight - AXIS_MIN) / (AXIS_MAX - AXIS_MIN);
}
