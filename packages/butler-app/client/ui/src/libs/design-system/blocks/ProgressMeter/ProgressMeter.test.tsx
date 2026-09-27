/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressMeter } from "./ProgressMeter";

const css = readFileSync(new URL("./ProgressMeter.module.css", import.meta.url), "utf8");

test("ProgressMeter fills with a scaleX transform, never an animated width", () => {
  const document = new JSDOM(renderToStaticMarkup(<ProgressMeter label="Planned" value={40} />)).window.document;
  const fill = document.querySelector<HTMLElement>('[data-slot="progress-fill"]')!;
  expect(fill.getAttribute("style")).toContain("--progress-scale:0.4");
  expect(fill.getAttribute("style")).not.toContain("width");
  const rule = /\.fill\s*\{([^}]*)\}/u.exec(css)![1]!;
  expect(rule).toMatch(/transform:\s*scaleX\(var\(--progress-scale\)\)/u);
  expect(rule).toMatch(/transform-origin:\s*left center/u);
  expect(rule).toMatch(/transition:\s*transform var\(--motion-deliberate\) var\(--motion-ease-decelerate\)/u);
  expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.fill\s*\{\s*transition:\s*none/u);
});

test("ProgressMeter clamps the scale to 0..1", () => {
  const over = new JSDOM(renderToStaticMarkup(<ProgressMeter bare value={180} ariaLabel="x" />)).window.document;
  expect(over.querySelector('[data-slot="progress-fill"]')!.getAttribute("style")).toContain("--progress-scale:1");
  const under = new JSDOM(renderToStaticMarkup(<ProgressMeter bare value={-5} ariaLabel="x" />)).window.document;
  expect(under.querySelector('[data-slot="progress-fill"]')!.getAttribute("style")).toContain("--progress-scale:0");
});
