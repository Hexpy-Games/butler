// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { inspectorSlideClip } from "./shellFrame";

test("the inspector slide clips the flat workspace's right edge, and in cards only below the title row", () => {
  expect(inspectorSlideClip("flat", 375.6, 48)).toBe("inset(0px 376px 0px 0px)");
  expect(inspectorSlideClip("cards", 384, 48))
    .toBe("polygon(0px 0px, 100% 0px, 100% 48px, calc(100% - 384px) 48px, calc(100% - 384px) 100%, 0px 100%)");
  // Same vertex count at both ends, so the polygon interpolates.
  expect(inspectorSlideClip("cards", 0, 48).split(",").length).toBe(inspectorSlideClip("cards", 384, 48).split(",").length);
});

test("the cards frame tokens: geometry once, surfaces in every theme, a quieter edge in dark", () => {
  const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");
  const count = (name: string) => tokens.match(new RegExp(`\\s${name}:`, "gu"))?.length ?? 0;
  for (const name of ["--shell-card-inset", "--shell-card-gap", "--shell-card-radius", "--shell-card-shadow"]) expect(count(name)).toBe(1);
  for (const name of ["--shell-bg", "--shell-card-bg", "--shell-card-edge"]) expect(count(name)).toBe(3);
  const dark = tokens.slice(tokens.indexOf(".theme-dark {"), tokens.indexOf(".theme-light {"));
  expect(dark).toContain("--shell-card-edge: color-mix(in srgb, var(--text-primary) 6%, transparent)");
  expect(tokens.slice(0, tokens.indexOf(".theme-dark {"))).toContain("--shell-card-edge: color-mix(in srgb, var(--text-primary) 8%, transparent)");
});
