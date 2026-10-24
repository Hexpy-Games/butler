// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the cards frame tokens: geometry once, surfaces in every theme, a quieter edge in dark", () => {
  const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");
  const count = (name: string) => tokens.match(new RegExp(`\\s${name}:`, "gu"))?.length ?? 0;
  for (const name of ["--shell-card-inset", "--shell-card-gap", "--shell-card-radius", "--shell-card-shadow"]) expect(count(name)).toBe(1);
  for (const name of ["--shell-bg", "--shell-card-bg", "--shell-card-edge", "--shell-sheet-tint", "--shell-page-shadow"]) {
    expect(count(name)).toBe(3);
  }
  const dark = tokens.slice(tokens.indexOf(".theme-dark {"), tokens.indexOf(".theme-light {"));
  expect(dark).toContain("--shell-card-edge: color-mix(in srgb, var(--text-primary) 6%, transparent)");
  expect(tokens.slice(0, tokens.indexOf(".theme-dark {"))).toContain("--shell-card-edge: color-mix(in srgb, var(--text-primary) 8%, transparent)");
});

test("the cards browser sheet: a faint tint and a tight page shadow in light, dark unchanged", () => {
  const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");
  const cards = readFileSync(new URL("./AdaptiveShellCards.module.css", import.meta.url), "utf8");
  const dark = tokens.slice(tokens.indexOf(".theme-dark {"), tokens.indexOf(".theme-light {"));
  const lights = [tokens.slice(0, tokens.indexOf(".theme-dark {")), tokens.slice(tokens.indexOf(".theme-light {"))];
  for (const light of lights) {
    expect(light).toContain("--shell-sheet-tint: 1%;");
    expect(light).toMatch(/--shell-page-shadow:\s+0 1px 2px rgba\(15, 18, 22, 0\.05\), 0 2px 6px rgba\(15, 18, 22, 0\.04\);/u);
  }
  expect(dark).toContain("--shell-sheet-tint: 2.5%;");
  expect(dark).toMatch(/--shell-page-shadow:\s+0 1px 2px rgba\(0, 0, 0, 0\.32\), 0 6px 20px rgba\(0, 0, 0, 0\.28\);/u);
  expect(cards).toContain("var(--text-primary) var(--shell-sheet-tint)");
  const pane = readFileSync(new URL("../BrowserPane/BrowserPane.module.css", import.meta.url), "utf8");
  expect(pane).toContain("--browser-card-shadow: var(--shell-page-shadow);");
});
