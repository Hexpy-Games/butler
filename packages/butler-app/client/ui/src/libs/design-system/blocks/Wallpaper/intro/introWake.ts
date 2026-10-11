// What wakes the dried intro print: the print beat when the card changes and the pointer stir (fine pointers only).
import { introBeat } from "./introParams";

/** The print beat when the card changes (intro and step): plates x4 and back, keep-out 420 to 520. */
const RISO_INTRO_BEAT_MS = 600;
/** The pointer stir decays with tau 320 ms and stops by itself below 0.4%. */
const RISO_INTRO_STIR_DECAY_MS = 320;

type Rect = readonly [number, number, number, number];

export interface IntroWake {
  /** The card moves from one rect to another (canvas CSS px). */
  beat(from: Rect, to: Rect): void;
  /** A fine pointer moved to x, y (canvas CSS px); true when the stir is strong enough to draw. */
  pointer(x: number, y: number): boolean;
  /** Advances by `dt` ms; true while something still moves. */
  step(dt: number): boolean;
  /** The beat card (null: the card at rest), the plate pulse and the stir (x, y, push x, push y). */
  looks(): { card: Rect | null; pulse: number; stir: Rect };
  moving(): boolean;
  clear(): void;
}

export function createIntroWake(): IntroWake {
  let shift: { from: Rect; to: Rect; ms: number } | null = null;
  const stir = { x: 0, y: 0, vx: 0, vy: 0, s: 0, lx: Number.NaN, ly: Number.NaN };
  return {
    beat(from, to) {
      shift = { from, to, ms: 0 };
    },
    pointer(x, y) {
      const dx = x - stir.lx, dy = y - stir.ly, len = Math.hypot(dx, dy);
      if (len > 0.5) Object.assign(stir, { vx: dx / len, vy: dy / len, s: Math.min(1, Math.max(stir.s, len / 24)) });
      Object.assign(stir, { x, y, lx: x, ly: y });
      return stir.s > 0.004;
    },
    step(dt) {
      let more = false;
      if (shift) {
        shift.ms += dt;
        if (shift.ms >= RISO_INTRO_BEAT_MS) shift = null;
        else more = true;
      }
      if (stir.s > 0.004) {
        stir.s *= Math.exp(-dt / RISO_INTRO_STIR_DECAY_MS);
        more = true;
      } else stir.s = 0;
      return more;
    },
    looks() {
      const beat = shift ? introBeat(Math.min(1, shift.ms / RISO_INTRO_BEAT_MS), shift.from, shift.to) : null;
      return { card: beat?.card ?? null, pulse: beat?.pulse ?? 0, stir: [stir.x, stir.y, stir.vx * stir.s, stir.vy * stir.s] };
    },
    moving: () => shift !== null || stir.s > 0,
    clear() {
      shift = null;
      stir.s = 0;
    },
  };
}
