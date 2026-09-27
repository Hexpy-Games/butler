/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { contrastGrade, contrastRatio, flatten, formatRatio, inkOn, parseColor } from "./contrast";

describe("contrast", () => {
  test("parses computed rgb, rgba and color(srgb) values", () => {
    expect(parseColor("rgb(34, 35, 38)")).toEqual({ r: 34, g: 35, b: 38, a: 1 });
    expect(parseColor("rgba(255, 255, 255, 0.96)")).toEqual({ r: 255, g: 255, b: 255, a: 0.96 });
    expect(parseColor("rgb(0 0 0 / 50%)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor("color(srgb 1 0.5 0 / 0.4)")).toEqual({ r: 255, g: 127.5, b: 0, a: 0.4 });
    expect(parseColor("linear-gradient(red, blue)")).toBeNull();
  });

  test("matches the WCAG reference ratios", () => {
    const black = parseColor("rgb(0, 0, 0)")!;
    const white = parseColor("rgb(255, 255, 255)")!;
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1 AA threshold color.
    expect(contrastRatio(parseColor("rgb(118, 118, 118)")!, white)).toBeCloseTo(4.54, 2);
  });

  test("flattens translucent layers before measuring", () => {
    const half = flatten(parseColor("rgba(0, 0, 0, 0.5)")!, parseColor("rgb(255, 255, 255)")!);
    expect(half.a).toBe(1);
    expect(half.r).toBeCloseTo(127.5, 5);
  });

  test("grades and formats without rounding up past a threshold", () => {
    expect(contrastGrade(7.2)).toBe("AAA");
    expect(contrastGrade(4.5)).toBe("AA");
    expect(contrastGrade(4.49)).toBe("AA large");
    expect(contrastGrade(2.9)).toBe("Fail");
    expect(formatRatio(4.49)).toBe("4.4:1");
    expect(inkOn(parseColor("rgb(0, 82, 179)")!)).toBe("light");
    expect(inkOn(parseColor("rgb(255, 199, 26)")!)).toBe("dark");
  });
});
