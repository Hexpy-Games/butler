// test-category: pure-logic
import { expect, test } from "bun:test";
import { defaultWindowBounds } from "../../packages/butler-app/client/electron/window-bounds.mjs";

test("large displays use 1440 by 900 centered in the work area", () => {
  expect(defaultWindowBounds({ x: 0, y: 25, width: 2560, height: 1415 }))
    .toEqual({ x: 560, y: 283, width: 1440, height: 900 });
});

test("each dimension is capped independently at 90 percent", () => {
  expect(defaultWindowBounds({ x: 0, y: 25, width: 1512, height: 900 }))
    .toEqual({ x: 76, y: 70, width: 1360, height: 810 });
  expect(defaultWindowBounds({ x: 0, y: 0, width: 1920, height: 800 }))
    .toEqual({ x: 240, y: 40, width: 1440, height: 720 });
});

test("small displays and offset displays stay centered within one DIP", () => {
  for (const area of [
    { x: -1280, y: 100, width: 1280, height: 720 },
    { x: 1920, y: -100, width: 375, height: 500 },
    { x: 10, y: 20, width: 801, height: 601 },
  ]) {
    const bounds = defaultWindowBounds(area);
    expect(bounds.width).toBe(Math.floor(area.width * 0.9));
    expect(bounds.height).toBe(Math.floor(area.height * 0.9));
    expect(Math.abs(bounds.x - area.x - (area.width - bounds.width) / 2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(bounds.y - area.y - (area.height - bounds.height) / 2)).toBeLessThanOrEqual(0.5);
  }
});
