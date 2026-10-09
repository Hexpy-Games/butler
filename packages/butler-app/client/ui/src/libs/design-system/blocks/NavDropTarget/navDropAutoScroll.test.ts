// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { NAV_DROP_AUTO_SCROLL_EDGE, navDropAutoScrollStep } from "./navDropAutoScroll";

test("auto-scroll runs only inside the 40px edge bands and speeds up toward the edge", () => {
  expect(NAV_DROP_AUTO_SCROLL_EDGE).toBe(40);
  const [top, bottom] = [100, 600];
  expect(navDropAutoScrollStep(350, top, bottom)).toBe(0);
  expect(navDropAutoScrollStep(140, top, bottom)).toBe(0);
  expect(navDropAutoScrollStep(560, top, bottom)).toBe(0);
  expect(navDropAutoScrollStep(139, top, bottom)).toBeLessThan(0);
  expect(navDropAutoScrollStep(561, top, bottom)).toBeGreaterThan(0);
  expect(Math.abs(navDropAutoScrollStep(100, top, bottom))).toBeGreaterThan(Math.abs(navDropAutoScrollStep(130, top, bottom)));
  expect(navDropAutoScrollStep(90, top, bottom)).toBe(-12);
  expect(navDropAutoScrollStep(620, top, bottom)).toBe(12);
});

test("a list no taller than both bands never auto-scrolls", () => {
  expect(navDropAutoScrollStep(0, 0, 80)).toBe(0);
  expect(navDropAutoScrollStep(80, 0, 80)).toBe(0);
});
