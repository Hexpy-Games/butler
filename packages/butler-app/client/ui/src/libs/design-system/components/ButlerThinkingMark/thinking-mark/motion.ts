import { MORPH_SPRING, SPRING_SUBSTEP_S } from "./constants";

export interface SpringState {
  x: number;
  v: number;
}

export function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}

/** Damped spring, sub-stepped at 5ms for stability. */
export function spring(state: SpringState, target: number, k: number, zeta: number, dt: number) {
  const damping = 2 * zeta * Math.sqrt(k);
  const steps = Math.max(1, Math.ceil(dt / SPRING_SUBSTEP_S));
  const h = dt / steps;
  for (let i = 0; i < steps; i += 1) {
    state.v += (k * (target - state.x) - damping * state.v) * h;
    state.x += state.v * h;
  }
}

/** Morph progress in [0, 1]: the one value every channel reads. */
export function progressOf(M: number) {
  return clamp(M, 0, 1);
}

/**
 * Motion clock speed: proportional to the morph, so the thinking motion runs
 * from the first frame and reaches full speed exactly as the morph lands (no hand-off).
 */
export function speedOf(M: number) {
  return progressOf(M);
}

/** Park-Miller LCG, deterministic per seed. */
export function createRand(seed: number) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/**
 * One spring M drives the whole morph; the motion clock th advances at speedOf(M), so motion runs
 * concurrently with the morph from frame one and decays to a stop exactly as M returns to 0.
 */
export class MorphSim {
  readonly M: SpringState = { x: 0, v: 0 };
  th = 0;
  th0 = 0;
  idle = true;

  get T() {
    return this.th - this.th0;
  }

  update(dt: number, working: boolean) {
    if (working && this.idle) this.th0 = this.th;
    spring(this.M, working ? 1 : 0, MORPH_SPRING.k, MORPH_SPRING.zeta, dt);
    this.th += dt * speedOf(this.M.x);
    this.idle = !working && Math.abs(this.M.x) < 0.003 && Math.abs(this.M.v) < 0.01;
    if (this.idle) {
      this.M.x = 0;
      this.M.v = 0;
    }
  }

  /**
   * Reduced motion has no morph (the component breathes the logo in CSS on the
   * DS pulse cadence instead): park at rest so leaving reduced mode starts from the logo.
   */
  park() {
    this.M.x = 0;
    this.M.v = 0;
    this.idle = true;
  }
}
