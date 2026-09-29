import type { WallpaperModuleMotion } from "./types";

/**
 * Default period (seconds) at which the engine wraps `u_time`, and the
 * longest a manifest `timePeriod` may be: 5000*PI, a whole multiple of the
 * built-ins' exact periods (bloom 200*PI, silk 312.5*PI), so their animation
 * stays continuous across the wrap while the uniform stays inside the mediump
 * range.
 */
export const WALLPAPER_TIME_PERIOD_SECONDS = 5000 * Math.PI;

const SECONDS_PER_DAY = 86_400;

/**
 * `u_time`: seconds wrapped to the module's `timePeriod` (default: the engine
 * period); constant for static modules.
 */
export function wallpaperShaderTime(
  milliseconds: number,
  motion: WallpaperModuleMotion,
  period: number = WALLPAPER_TIME_PERIOD_SECONDS,
): number {
  if (motion === "static") return 0;
  const seconds = (milliseconds / 1000) % period;
  return seconds < 0 ? seconds + period : seconds;
}

/** `u_dayPhase`: local time of day in 0..1 (0 = 00:00). */
export function wallpaperDayPhase(date: Date): number {
  const seconds = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000;
  return seconds / SECONDS_PER_DAY;
}
