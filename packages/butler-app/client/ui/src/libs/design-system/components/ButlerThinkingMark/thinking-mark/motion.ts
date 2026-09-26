import { MORPH_SPRING, SPRING_SUBSTEP_S, TAU, WAVE } from "./constants";

export interface SpringState {
  x: number;
  v: number;
}

export function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}

export function sstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Smootherstep on [0, 1]. */
export function ease(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
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

/** Local morph amount at normalized distance w from the crossing. */
export function mLocal(M: number, w: number) {
  return ease(clamp(M * (1 + WAVE) - WAVE * w, 0, 1));
}

/** Motion clock speed as a function of the morph: 0 at rest, 1 once formed. */
export function speedOf(M: number) {
  return sstep(0, 0.3, M);
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

/** UI timing from DS motion tokens (seconds), passed in by the component. */
export interface MorphTiming {
  /** Reduced-motion fade in/out (--motion-slow). */
  reducedFade: number;
  /** Reduced-motion breathe cycle (the Spinner's reduced pulse: 4 x --pulse-duration). */
  breathePeriod: number;
  /** Eased progress for the fade (--motion-ease-standard). */
  ease: (t: number) => number;
}

/**
 * One spring M drives the morph; the motion clock th advances at speedOf(M), so motion runs
 * concurrently with the morph from frame one and decays to a stop exactly as M returns to 0.
 */
export class MorphSim {
  readonly M: SpringState = { x: 0, v: 0 };
  th = 0;
  th0 = 0;
  idle = true;
  /** Reduced-motion breathe level (0 = still logo), eased from fade progress. */
  rm = 0;
  /** Linear fade progress behind rm. */
  fade = 0;
  /** Breathe clock, restarted on each entry so the cycle begins at full opacity. */
  clock = 0;

  readonly timing: MorphTiming;

  constructor(timing: MorphTiming) {
    this.timing = timing;
  }

  /** Breathe dip 0..1 (0 at full opacity) on the token cadence. */
  breathe() {
    return 0.5 - 0.5 * Math.cos((this.clock * TAU) / this.timing.breathePeriod);
  }

  get T() {
    return this.th - this.th0;
  }

  update(dt: number, working: boolean) {
    if (working && this.idle) this.th0 = this.th;
    spring(this.M, working ? 1 : 0, MORPH_SPRING.k, MORPH_SPRING.zeta, dt);
    this.th += dt * speedOf(clamp(this.M.x, 0, 1));
    this.idle = !working && Math.abs(this.M.x) < 0.003 && Math.abs(this.M.v) < 0.01;
    if (this.idle) {
      this.M.x = 0;
      this.M.v = 0;
    }
  }

  updateReduced(dt: number, working: boolean) {
    // no morph under reduced motion: park it at rest so leaving reduced mode starts from the logo
    this.M.x = 0;
    this.M.v = 0;
    this.idle = true;
    if (working && this.fade === 0) this.clock = 0;
    const step = dt / this.timing.reducedFade;
    this.fade = clamp(this.fade + (working ? step : -step), 0, 1);
    this.rm = this.fade === 0 || this.fade === 1 ? this.fade : this.timing.ease(this.fade);
    this.clock += dt;
  }

  reducedSettled(working: boolean) {
    return !working && this.fade === 0;
  }
}
