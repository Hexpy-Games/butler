// Pure drift policy of print modules (riso spec "Motion policy"): the rest drift, event envelopes and host speeds.
// Ported from the approved riso-core.js (v9); the numbers are the spec's.

/** Flow of the ink field per second at 1x: ink boundaries move about 2-3 CSS px/s (noticed, never watched). */
export const RISO_DRIFT_RATE = 0.035;
/** One crossfade segment: a pre-rendered keyframe every 8 s at 1x (0.28 flow). */
export const RISO_SEGMENT_MS = 8000;
/** Opacity steps of the crossfade per second at 1x (a timer, never rAF or a CSS transition). */
export const RISO_STEP_HZ = 4;
/** Live event frames: 6 fps at the envelope's tail, up to 30 at its peak and while a look tweens. */
export const RISO_LIVE_FLOOR_FPS = 6;
export const RISO_LIVE_CAP_FPS = 30;
/** The crossfade layer dissolves out over this when live event frames take over (no pop). */
export const RISO_ENTRY_DISSOLVE_MS = 250;
/** Window blur: half speed after 2 min, paused on the current mix after 10 min. */
export const RISO_BLUR_SLOW_MS = 2 * 60_000;
export const RISO_BLUR_FREEZE_MS = 10 * 60_000;
/** Shown or focused again after this long away fires the focus event. */
export const RISO_FOCUS_AWAY_MS = 5 * 60_000;
/** A column keep-out change eases over this. */
export const RISO_ZONE_EASE_MS = 300;

export type WallpaperEventKind = "focus" | "newChat" | "thinking" | "done";

/** A one-shot wallpaper event: a new `id` fires once. */
export interface WallpaperEvent {
  id: string | number;
  kind: WallpaperEventKind;
}

/** An event envelope: attack (smoothstep), hold, release ((1-k)^2), adding `v` flow/s at its peak. */
export interface DriftEnvelope {
  attack: number;
  hold: number;
  release: number;
  v: number;
}

/** Spec "Events": focus 6.1x, new chat 8.7x, thinking 2.4x, done 3.9x the drift at their peaks. */
export const RISO_EVENTS: Record<WallpaperEventKind, DriftEnvelope> = {
  focus: { attack: 400, hold: 200, release: 1500, v: 0.18 },
  newChat: { attack: 500, hold: 600, release: 2200, v: 0.27 },
  thinking: { attack: 400, hold: 0, release: 1200, v: 0.05 },
  done: { attack: 300, hold: 100, release: 1400, v: 0.1 },
};

export const driftEnvelopeLength = (e: DriftEnvelope) => e.attack + e.hold + e.release;
/** Extra flow one whole event adds (an event applied at once, e.g. while hidden or under reduced motion). */
export const driftEventArea = (e: DriftEnvelope) => (e.v * (e.attack / 2 + e.hold + e.release / 3)) / 1000;

/** The envelope's level 0..1 at `ms` after its start. */
export function driftEnvelope(e: DriftEnvelope, ms: number): number {
  if (ms < 0) return 0;
  if (ms < e.attack) {
    const k = ms / e.attack;
    return k * k * (3 - 2 * k);
  }
  let rest = ms - e.attack;
  if (rest < e.hold) return 1;
  rest -= e.hold;
  if (rest < e.release) {
    const k = rest / e.release;
    return (1 - k) * (1 - k);
  }
  return 0;
}

export interface DriftBoost {
  e: DriftEnvelope;
  t0: number;
}

/** Overlapping events add; the boost is capped at 1. */
export function driftBoostLevel(boosts: readonly DriftBoost[], now: number): number {
  let level = 0;
  for (const boost of boosts) level += driftEnvelope(boost.e, now - boost.t0);
  return Math.min(1, level);
}

/** Extra flow velocity (flow/s) of the running events. */
export function driftExtraVelocity(boosts: readonly DriftBoost[], now: number): number {
  let v = 0;
  for (const boost of boosts) v += boost.e.v * driftEnvelope(boost.e, now - boost.t0);
  return v;
}

/** The flow the running events still owe from `now` to their ends (they end at once: hidden, or the watchdog). */
export function driftRemainingFlow(boosts: readonly DriftBoost[], now: number): number {
  let flow = 0;
  for (const boost of boosts) {
    const end = driftEnvelopeLength(boost.e);
    for (let ms = Math.max(0, now - boost.t0); ms < end; ms += 10) flow += boost.e.v * driftEnvelope(boost.e, ms) * 0.01;
  }
  return flow;
}

/** Live frame rate for a boost level: 6 + 24 x boost, capped at 30; always 30 while a look tweens. */
export function driftLiveFps(boost: number, tweening: boolean): number {
  return tweening ? RISO_LIVE_CAP_FPS : Math.min(RISO_LIVE_CAP_FPS, RISO_LIVE_FLOOR_FPS + (RISO_LIVE_CAP_FPS - RISO_LIVE_FLOOR_FPS) * boost);
}

/**
 * How the host lets a print drift. `still`: a static print, events are instant stills (reduced motion, the user's
 * pause, low power or thermal pressure, software GL, a degraded watchdog). `frozen`: paused on the current mix, events
 * still animate (blurred 10 min). `slow`: half speed (blurred 2 min, or on battery). Else full speed.
 */
export type DriftHost = "full" | "slow" | "frozen" | "still";

/** Drift speed factor of a host state (0 = no drift). */
export const driftFactor = (host: DriftHost) => (host === "full" ? 1 : host === "slow" ? 0.5 : 0);
/** Duration of one crossfade segment at a factor. */
export const driftSegmentMs = (factor: number) => RISO_SEGMENT_MS / factor;
/** Gap between crossfade opacity steps at a factor (at most 30 a second). */
export const driftStepMs = (factor: number) => 1000 / Math.min(RISO_LIVE_CAP_FPS, RISO_STEP_HZ * factor);
/** Flow one segment covers (the next keyframe is this far ahead, whatever the speed). */
export const RISO_SEGMENT_FLOW = (RISO_DRIFT_RATE * RISO_SEGMENT_MS) / 1000;
