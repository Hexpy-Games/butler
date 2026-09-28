/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { ShieldCheck } from "../Icons";
import { IconTile } from "./IconTile";

const css = readFileSync(new URL("./IconTile.module.css", import.meta.url), "utf8");

function first(markup: string) {
  return new JSDOM(markup).window.document.body.firstElementChild!;
}

test("IconTile is a decorative square: md and neutral by default", () => {
  const tile = first(renderToStaticMarkup(<IconTile><ShieldCheck /></IconTile>));
  expect(tile.getAttribute("data-slot")).toBe("icon-tile");
  expect(tile.getAttribute("data-size")).toBe("md");
  expect(tile.getAttribute("data-tone")).toBe("neutral");
  expect(tile.getAttribute("aria-hidden")).toBe("true");
});

test("sizes and tones map to fixed squares and token colors", () => {
  const tile = first(renderToStaticMarkup(<IconTile size="xl" tone="plain"><ShieldCheck /></IconTile>));
  expect(tile.getAttribute("data-size")).toBe("xl");
  expect(tile.getAttribute("data-tone")).toBe("plain");
  for (const size of ["sm", "md", "lg", "xl"]) expect(css).toContain(`.tile[data-size="${size}"]`);
  expect(css).toMatch(/\.tile\[data-tone="accent"\]\s*\{[^}]*color: var\(--color-info-text\)/u);
  expect(css).toMatch(/\.tile\[data-tone="danger"\]\s*\{[^}]*color: var\(--danger\)/u);
  expect(css).toMatch(/\.tile\[data-tone="plain"\]\s*\{[^}]*border-color: transparent/u);
});

test("an animated mark (AspectFrame) fills a plain tile and half of a filled one", () => {
  expect(css).toMatch(/\.tile > \[data-slot="aspect-frame"\]\s*\{[^}]*width: 50%/u);
  expect(css).toMatch(/\.tile\[data-tone="plain"\] > \[data-slot="aspect-frame"\]\s*\{[^}]*width: 100%/u);
});
