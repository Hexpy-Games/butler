/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Stack } from "./Stack";

test("compactGap sets the gap used at phone widths", () => {
  expect(renderToStaticMarkup(<Stack gap="sm" compactGap="lg">x</Stack>)).toContain('data-compact-gap="lg"');
  expect(renderToStaticMarkup(<Stack gap="sm">x</Stack>)).not.toContain("data-compact-gap");
  const css = readFileSync(new URL("./Stack.module.css", import.meta.url), "utf8").replace(/\s+/gu, " ");
  expect(css).toMatch(/@media \(width <= 640px\) \{[^@]*\.stack\[data-compact-gap="lg"\] \{ gap: var\(--space-lg\); \}/u);
});
