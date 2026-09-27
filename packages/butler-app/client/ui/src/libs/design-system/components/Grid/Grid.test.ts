/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./Grid.module.css", import.meta.url), "utf8").replace(/\s+/gu, " ");
const source = readFileSync(new URL("./Grid.tsx", import.meta.url), "utf8");
const presets = [...source.match(/type GridColumnPreset = ([^;]+);/u)![1]!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);

/** Splits a track list into its `minmax(...)` argument lists and everything else. */
function minmaxCalls(value: string): { calls: string[]; rest: string } {
  const calls: string[] = [];
  let rest = "";
  let index = 0;
  while (index < value.length) {
    if (!value.startsWith("minmax(", index)) {
      rest += value[index];
      index += 1;
      continue;
    }
    let depth = 0;
    let end = index + "minmax".length;
    for (; end < value.length; end += 1) {
      if (value[end] === "(") depth += 1;
      if (value[end] === ")") depth -= 1;
      if (depth === 0) break;
    }
    calls.push(value.slice(index + "minmax(".length, end));
    index = end + 1;
  }
  return { calls, rest };
}

const trackLists = [...css.matchAll(/grid-template-columns: ([^;]+);/gu)].map((match) => match[1]!);

test("every column track can shrink to its container: no bare fr, no fixed floor", () => {
  expect(trackLists.length).toBeGreaterThan(0);
  for (const tracks of trackLists) {
    const { calls, rest } = minmaxCalls(tracks);
    // A bare `1fr` is `minmax(auto, 1fr)`: wide content would widen the grid.
    expect({ tracks, bareFr: /\d*\.?\d+fr/u.test(rest) }).toEqual({ tracks, bareFr: false });
    // Each minimum is 0 or clamped to the container, e.g. min(100%, 240px).
    for (const call of calls) {
      const floor = call.split(/,(?![^(]*\))/u)[0]!.trim();
      expect({ tracks, floorOk: /^(0|min\([^)]*%[^)]*\))$/u.test(floor) }).toEqual({ tracks, floorOk: true });
    }
  }
});

test("grid cells may shrink below their content's width", () => {
  expect(css).toMatch(/\.grid > \* \{[^}]*min-width: 0;/u);
});

test("every preset has a static, a responsive base and a wide rule", () => {
  expect(presets).toContain("main-aside");
  for (const preset of presets) {
    expect(css).toContain(`.columns-${preset} {`);
    expect(css).toContain(`.responsive[data-columns="${preset}"] {`);
    expect(css).toContain(`.responsive[data-columns-wide="${preset}"] {`);
  }
});
