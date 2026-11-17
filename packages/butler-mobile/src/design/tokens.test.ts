import { expect, test } from "bun:test";
import { alpha, linearEasing, mix, opaque } from "./tokens";

// test-category: pure-logic
test("derived colours match CSS color-mix", () => {
  const cases: [string, string][] = [
    [alpha("rgba(190, 56, 54, 1)", 0.12), "rgba(190, 56, 54, 0.12)"],
    [alpha("rgba(255, 255, 255, 0.96)", 0.86), "rgba(255, 255, 255, 0.8256)"],
    [opaque("rgba(37, 38, 41, 0.98)"), "rgba(37, 38, 41, 1)"],
    [mix("rgba(0, 122, 255, 1)", 0.52, "rgba(233, 234, 236, 1)"), "rgba(112, 176, 246, 1)"],
    [mix("rgba(0, 122, 255, 1)", 0.52, "rgba(255, 255, 255, 0.1)"), "rgba(22, 133, 255, 0.568)"],
  ];
  for (const [actual, expected] of cases) expect(actual).toBe(expected);
});

// test-category: pure-logic
test("a linear() easing follows its points", () => {
  const f = linearEasing([[0, 0], [0.5, 0.25], [1.2, 0.5], [1, 1]]);
  expect(f(0)).toBe(0);
  expect(f(1)).toBe(1);
  expect(f(0.125)).toBeCloseTo(0.25);
  expect(f(0.5)).toBeCloseTo(1.2);
  expect(f(0.75)).toBeCloseTo(1.1);
});
