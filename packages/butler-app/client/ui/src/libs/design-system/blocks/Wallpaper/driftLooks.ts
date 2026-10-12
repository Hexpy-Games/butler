// Event looks of print modules (riso-core.js LOOKS and tweens): plate lift, focus breathing, dot gain, the new-chat
// drop and the column keep-out, as tweens stepped by live frames.
import { motionEasing } from "../../lib/motion";
import { RISO_ZONE_EASE_MS, type WallpaperEventKind } from "./drift";

export interface DriftLookState {
  lift: number;
  misPulse: number;
  gain: number;
  dropX: number;
  dropY: number;
  dropP: number;
  dropS: number;
  colL: number;
  colR: number;
  colT: number;
  colOn: number;
}
type Key = keyof DriftLookState;
type Ease = (t: number) => number;
interface Tween { key: Key; t0: number; dur: number; from: number; to: number; ease: Ease; amp?: number }

/** A cubic-bezier easing (Newton steps, as the prototype). */
function bezier(x1: number, y1: number, x2: number, y2: number): Ease {
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 8; i++) {
      const x = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u - t;
      const dx = 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
      if (Math.abs(x) < 1e-5 || dx === 0) break;
      u -= x / dx;
    }
    return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  };
}

let standard: Ease | null = null;
/** `--motion-ease-standard`, read once. */
export function standardEase(): Ease {
  if (standard) return standard;
  const points = /cubic-bezier\(([^)]+)\)/u.exec(motionEasing("standard"))?.[1]?.split(",").map(Number) ?? [];
  standard = points.length === 4 && !points.some(Number.isNaN) ? bezier(points[0]!, points[1]!, points[2]!, points[3]!) : bezier(0.2, 0, 0, 1);
  return standard;
}
const linear: Ease = (t) => t;

export interface DriftLooks {
  state: DriftLookState;
  /** Starts an event's look. `keep` is the content keep-out (CSS px) the new-chat drop avoids. */
  look(kind: WallpaperEventKind, now: number, size: readonly [number, number], keep: readonly number[]): void;
  /** Eases the column keep-out to `target` (left, right, top, on). */
  zone(target: readonly [number, number, number, number], now: number): void;
  /** Sets the column at once (reduced motion, low power, hidden, nothing to ease from). */
  snapZone(target: readonly [number, number, number, number]): void;
  step(now: number): void;
  /** Jumps every look to its end. */
  finish(): void;
  tweening(): boolean;
}

export function createDriftLooks(): DriftLooks {
  const state: DriftLookState = { lift: 0, misPulse: 0, gain: 0, dropX: 0, dropY: 0, dropP: 1, dropS: 0, colL: 0, colR: 0, colT: 0, colOn: 0 };
  let tweens: Tween[] = [];
  let seed = 0;
  const set = (key: Key, to: number, dur: number, ease: Ease, now: number) => {
    tweens = tweens.filter((tween) => tween.key !== key);
    tweens.push({ key, t0: now, dur, from: state[key], to, ease });
  };
  const pulse = (key: Key, amp: number, dur: number, now: number) => {
    tweens = tweens.filter((tween) => tween.key !== key);
    tweens.push({ key, t0: now, dur, from: 0, to: 0, ease: linear, amp });
  };
  // riso-core.js rnd(): xorshift from the golden-ratio seed.
  const rnd = () => {
    seed = (seed || 0x9e3779b9) ^ (seed << 13);
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 10000) / 10000;
  };
  const dropSpot = ([W, H]: readonly [number, number], [kx = 0, ky = 0, kw = 0, kh = 0]: readonly number[]): [number, number] => {
    for (let i = 0; i < 32; i++) {
      const x = W * (0.06 + 0.88 * rnd()), y = H * (0.06 + 0.82 * rnd());
      const dx = Math.max(kx - x, 0, x - (kx + kw)), dy = Math.max(ky - y, 0, y - (ky + kh));
      if (Math.hypot(dx, dy) > 160) return [x, y];
    }
    return [W * 0.94, H * 0.12];
  };
  const end = (tween: Tween) => {
    state[tween.key] = tween.amp === undefined ? tween.to : 0;
    if (tween.key === "dropP") state.dropS = 0;
  };
  return {
    state,
    look(kind, now, size, keep) {
      if (kind === "focus") pulse("misPulse", 0.5, 1400, now);
      else if (kind === "thinking") set("lift", 1, 900, standardEase(), now);
      else if (kind === "done") { set("lift", 0, 900, standardEase(), now); pulse("gain", 1, 900, now); }
      else {
        [state.dropX, state.dropY] = dropSpot(size, keep);
        state.dropS = 1;
        state.dropP = 0;
        set("dropP", 1, 2600, linear, now);
      }
    },
    zone(target, now) {
      (["colL", "colR", "colT", "colOn"] as const).forEach((key, i) => set(key, target[i]!, RISO_ZONE_EASE_MS, standardEase(), now));
    },
    snapZone(target) {
      tweens = tweens.filter((tween) => !tween.key.startsWith("col"));
      [state.colL, state.colR, state.colT, state.colOn] = target;
    },
    step(now) {
      tweens = tweens.filter((tween) => {
        const k = Math.min(1, Math.max(0, (now - tween.t0) / tween.dur));
        state[tween.key] = tween.amp === undefined ? tween.from + (tween.to - tween.from) * tween.ease(k) : tween.amp * Math.sin(Math.PI * k);
        if (k < 1) return true;
        end(tween);
        return false;
      });
    },
    finish() {
      for (const tween of tweens) end(tween);
      tweens = [];
    },
    tweening: () => tweens.length > 0,
  };
}
