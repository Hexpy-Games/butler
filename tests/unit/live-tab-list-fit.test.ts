// test-category: pure-logic
import { expect, test } from "bun:test";
import { fitFavicons } from "../../packages/butler-app/client/ui/src/libs/design-system/blocks/LiveTabList/fitFavicons";

test("fits whole icons, reserving the exact remainder label and its gap", () => {
  const widths = [0, 18, 18, 18, 18, 18, 18, 18, 18, 18];
  expect(fitFavicons(2, 36, 16, 4, widths)).toBe(2);
  expect(fitFavicons(9, 140, 16, 4, widths)).toBe(6);
  expect(fitFavicons(9, 137, 16, 4, widths)).toBe(5);
  expect(fitFavicons(9, 18, 16, 4, widths)).toBe(0);
  expect(fitFavicons(0, 0, 16, 4, widths)).toBe(0);
  expect(fitFavicons(9, 176, 16, 4, widths)).toBe(9);
  expect(fitFavicons(12, 60, 16, 4, [...widths, 26, 26, 26])).toBe(1);
});
