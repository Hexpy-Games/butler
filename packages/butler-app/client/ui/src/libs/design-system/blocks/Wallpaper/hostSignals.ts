// Host signals of drifting prints: window blur (half speed after 2 min, paused after 10), the return after 5 min
// away (the focus event) and the host-constrained flag (low power or thermal pressure) the app sets.
import { RISO_BLUR_FREEZE_MS, RISO_BLUR_SLOW_MS, RISO_FOCUS_AWAY_MS } from "./drift";

/** 0 = focused, 1 = blurred 2 min or more, 2 = blurred 10 min or more. */
export type WallpaperWindowBlur = 0 | 1 | 2;

let constrained = false;
const constrainedListeners = new Set<(value: boolean) => void>();

/**
 * Low Power Mode or thermal pressure (from the app's power signals): drifting wallpapers hold a static print
 * and events draw instant stills. Every mounted wallpaper follows it; unset, nothing is constrained.
 */
export function setWallpaperHostConstrained(value: boolean): void {
  if (value === constrained) return;
  constrained = value;
  for (const listener of [...constrainedListeners]) listener(value);
}

export function wallpaperHostConstrained(): boolean {
  return constrained;
}

export interface WallpaperHostCallbacks {
  onBlur(level: WallpaperWindowBlur): void;
  onConstrained(value: boolean): void;
  /** Shown and focused again after at least 5 min hidden or blurred. */
  onReturn(): void;
}

/** Watches window focus and visibility (timers only while blurred) and the constrained flag; returns the cleanup. */
export function watchWallpaperHost({ onBlur, onConstrained, onReturn }: WallpaperHostCallbacks): () => void {
  let timers: number[] = [];
  let awaySince: number | null = null;
  const clear = () => {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  };
  const present = () => document.visibilityState !== "hidden" && document.hasFocus();
  const away = () => {
    awaySince ??= performance.now();
    if (timers.length > 0 || document.hasFocus()) return;
    timers = [window.setTimeout(() => onBlur(1), RISO_BLUR_SLOW_MS), window.setTimeout(() => onBlur(2), RISO_BLUR_FREEZE_MS)];
  };
  const back = () => {
    if (!present()) return away();
    clear();
    onBlur(0);
    const since = awaySince;
    awaySince = null;
    if (since !== null && performance.now() - since >= RISO_FOCUS_AWAY_MS) onReturn();
  };
  const changed = () => (present() ? back() : away());
  window.addEventListener("blur", changed);
  window.addEventListener("focus", changed);
  document.addEventListener("visibilitychange", changed);
  constrainedListeners.add(onConstrained);
  if (!present()) away();
  return () => {
    clear();
    window.removeEventListener("blur", changed);
    window.removeEventListener("focus", changed);
    document.removeEventListener("visibilitychange", changed);
    constrainedListeners.delete(onConstrained);
  };
}
