// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Pick marks are drawn over any web page. Each outline is the pick ink
// between white keylines: one of the two must reach 3:1 against white, black
// and a mid-grey photo. The badge and tag put white text on the ink (4.5:1).
const css = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");

function token(name: string): string {
  const value = new RegExp(`\\s${name}:\\s*([^;]+);`, "u").exec(css)?.[1]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  const alias = /^var\((--[\w-]+)\)$/u.exec(value);
  return alias ? token(alias[1]!) : value;
}

function rgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/iu.exec(value);
  if (hex) return [0, 2, 4].map((offset) => Number.parseInt(hex[1]!.slice(offset, offset + 2), 16)) as [number, number, number];
  throw new Error(`unsupported ${value}`);
}

function luminance([r, g, b]: [number, number, number]) {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function ratio(a: [number, number, number], b: [number, number, number]) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

const ink = rgb(token("--browser-pick-ink"));
const keyline = rgb(token("--browser-pick-keyline"));
const pages: Record<string, [number, number, number]> = { white: [255, 255, 255], black: [0, 0, 0], photo: [128, 128, 128] };

test("pick outlines reach 3:1 on white, black and photo pages", () => {
  for (const [page, color] of Object.entries(pages)) {
    expect({ page, ok: Math.max(ratio(ink, color), ratio(keyline, color)) >= 3 }).toEqual({ page, ok: true });
  }
});

test("badge and tag text read 4.5:1 on the pick ink", () => {
  expect(ratio(rgb(token("--neutral-white")), ink)).toBeGreaterThanOrEqual(4.5);
});
