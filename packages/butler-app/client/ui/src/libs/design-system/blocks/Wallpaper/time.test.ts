// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import bloomFragment from "./modules/butler.bloom/shader.frag?raw";
import silkFragment from "./modules/butler.silk/shader.frag?raw";
import { WALLPAPER_TIME_PERIOD_SECONDS, wallpaperDayPhase, wallpaperShaderTime } from "./time";

const MEDIUMP_MAX = 2 ** 14;
const TAU = Math.PI * 2;
// Exact common periods of each built-in's time terms: bloom frequencies are
// multiples of 0.01 rad/s, silk's of 0.0064 rad/s.
const BLOOM_PERIOD = 200 * Math.PI;
const SILK_PERIOD = 312.5 * Math.PI;

function isWholeNumber(value: number): boolean {
  return Math.abs(value - Math.round(value)) < 1e-9;
}

test("the engine period is a whole multiple of every built-in period and stays under mediump range", () => {
  expect(WALLPAPER_TIME_PERIOD_SECONDS).toBeLessThan(MEDIUMP_MAX);
  expect(isWholeNumber(WALLPAPER_TIME_PERIOD_SECONDS / BLOOM_PERIOD)).toBe(true);
  expect(isWholeNumber(WALLPAPER_TIME_PERIOD_SECONDS / SILK_PERIOD)).toBe(true);
});

test("every bloom time frequency repeats within the bloom period", () => {
  expect(bloomFragment).toContain("float t=u_time;");
  const frequencies = [...bloomFragment.matchAll(/t\*(\.\d+)/gu)].map((match) => Number(match[1]));
  expect(frequencies).toHaveLength(20);
  for (const frequency of frequencies) expect(isWholeNumber((BLOOM_PERIOD * frequency) / TAU)).toBe(true);
});

test("every silk phase frequency repeats within the silk period", () => {
  // phase = t*.64, used as phase, phase*.5, .02*phase*2.5, .1*phase*10 and phase*.18.
  for (const term of ["float phase=t*.64", "-phase)", "phase*.5", ".02*phase", ".1*phase", "phase*.18"]) {
    expect(silkFragment).toContain(term);
  }
  for (const frequency of [0.64, 0.64 * 0.5, 0.64 * 0.02 * 2.5, 0.64 * 0.1 * 10, 0.64 * 0.18]) {
    expect(isWholeNumber((SILK_PERIOD * frequency) / TAU)).toBe(true);
  }
});

test("shader time is seconds wrapped into a small, continuous range", () => {
  const period = WALLPAPER_TIME_PERIOD_SECONDS;
  for (const ms of [0, 16.7, 59_999, 3_600_000, 86_400_000 * 7]) {
    const value = wallpaperShaderTime(ms, "animated");
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(period);
    expect(wallpaperShaderTime(ms + period * 1000, "animated")).toBeCloseTo(value, 6);
  }
  expect(wallpaperShaderTime(1500, "animated")).toBeCloseTo(1.5, 9);
  expect(wallpaperShaderTime(-1500, "animated")).toBeCloseTo(period - 1.5, 6);
});

test("a module's timePeriod replaces the engine period", () => {
  const hour = 3600;
  expect(wallpaperShaderTime(37_000, "animated", hour)).toBeCloseTo(37, 9);
  expect(wallpaperShaderTime((hour + 37) * 1000, "animated", hour)).toBeCloseTo(37, 6);
  expect(wallpaperShaderTime(-1000, "animated", hour)).toBeCloseTo(hour - 1, 6);
  for (const ms of [0, 59_999, 86_400_000 * 7 + 5]) {
    const value = wallpaperShaderTime(ms, "animated", hour);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(hour);
  }
  // Omitted: the engine default.
  expect(wallpaperShaderTime(hour * 2000, "animated", undefined)).toBeCloseTo(hour * 2, 6);
});

test("static modules get a constant time", () => {
  expect(wallpaperShaderTime(0, "static")).toBe(0);
  expect(wallpaperShaderTime(86_400_000 * 3 + 1234, "static")).toBe(0);
  expect(wallpaperShaderTime(1234, "static", 60)).toBe(0);
});

test("the day phase is local time of day in 0..1", () => {
  expect(wallpaperDayPhase(new Date(2026, 8, 28, 0, 0, 0))).toBe(0);
  expect(wallpaperDayPhase(new Date(2026, 8, 28, 12, 0, 0))).toBe(0.5);
  expect(wallpaperDayPhase(new Date(2026, 8, 28, 18, 0, 0))).toBe(0.75);
  expect(wallpaperDayPhase(new Date(2026, 8, 28, 23, 59, 59, 999))).toBeLessThan(1);
});
