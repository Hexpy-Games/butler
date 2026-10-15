// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The pointer is drawn over any web page. Its outline is a dark halo under a
// white keyline: one of the two must reach 3:1 against white, black and a
// mid-grey photo; the tag's white text must read 4.5:1 on the light inks.
const css = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");
const lightScope = /\.theme-light \{([\s\S]*?)\n\}/u.exec(css)?.[1] ?? "";

function token(name: string, source = css): string {
  const value = new RegExp(`${name}:\\s*([^;]+);`, "u").exec(source)?.[1]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function rgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/iu.exec(value);
  if (hex) return [0, 2, 4].map((offset) => Number.parseInt(hex[1]!.slice(offset, offset + 2), 16)) as [number, number, number];
  const fn = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/u.exec(value);
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])];
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

const halo = rgb(token("--grayscale-11"));
const keyline = rgb(token("--neutral-white"));
const pages: Record<string, [number, number, number]> = { white: [255, 255, 255], black: [0, 0, 0], photo: [128, 128, 128] };

test("the pointer outline reaches 3:1 on white, black and photo pages", () => {
  for (const [page, color] of Object.entries(pages)) {
    expect({ page, ok: Math.max(ratio(halo, color), ratio(keyline, color)) >= 3 }).toEqual({ page, ok: true });
  }
});

test("the tag's white text reads 4.5:1 on the light inks it is drawn with", () => {
  for (const ink of ["--butler-ink-blue", "--butler-ink-purple"]) {
    expect({ ink, ok: ratio(keyline, rgb(token(ink, lightScope))) >= 4.5 }).toEqual({ ink, ok: true });
  }
});
