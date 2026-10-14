// The setup card keep-out of a drifting print. A setup card that moves (a step change, a resize, content that loads
// in) eases the keep-out from where it was to where it is over the print beat, on live frames, instead of waiting
// for the next keyframe as a scrolling conversation does. Allocation free per frame: the eased rect is reused.
import { standardEase } from "./driftLooks";
import { RISO_INTRO_BEAT_MS } from "./intro/introWake";
import type { WallpaperContentRect } from "./types";

export interface DriftKeepOut {
  /** The keep-out to draw at `now`: the eased rect while it moves, else the resting one. */
  current(now: number): WallpaperContentRect | null;
  /** Eases from `from` (or from where a running ease is) to `to`; false when nothing moves. */
  move(from: WallpaperContentRect, to: WallpaperContentRect, now: number): boolean;
  moving(): boolean;
  /** Ends a running ease at once (static print, hidden window). */
  clear(): void;
}

const copy = (target: WallpaperContentRect, source: WallpaperContentRect) => {
  target.x = source.x;
  target.y = source.y;
  target.width = source.width;
  target.height = source.height;
};
const near = (a: WallpaperContentRect, b: WallpaperContentRect) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.width - b.width) + Math.abs(a.height - b.height) < 0.5;

export function createDriftKeepOut(rest: () => WallpaperContentRect | null): DriftKeepOut {
  const from: WallpaperContentRect = { x: 0, y: 0, width: 0, height: 0 };
  const to: WallpaperContentRect = { x: 0, y: 0, width: 0, height: 0 };
  const eased: WallpaperContentRect = { x: 0, y: 0, width: 0, height: 0 };
  let t0 = 0;
  let active = false;
  const current = (now: number): WallpaperContentRect | null => {
    if (!active) return rest();
    const k = (now - t0) / RISO_INTRO_BEAT_MS;
    if (k >= 1) {
      active = false;
      return rest();
    }
    const e = standardEase()(Math.max(0, k));
    eased.x = from.x + (to.x - from.x) * e;
    eased.y = from.y + (to.y - from.y) * e;
    eased.width = from.width + (to.width - from.width) * e;
    eased.height = from.height + (to.height - from.height) * e;
    return eased;
  };
  return {
    current,
    move(start, end, now) {
      // From where a running ease is now, from its end when it just finished, else from the previous rect.
      if (active && now - t0 < RISO_INTRO_BEAT_MS) copy(from, current(now)!);
      else copy(from, active ? to : start);
      active = false;
      if (near(from, end)) return false;
      copy(to, end);
      t0 = now;
      active = true;
      return true;
    },
    moving: () => active,
    clear() {
      active = false;
    },
  };
}
