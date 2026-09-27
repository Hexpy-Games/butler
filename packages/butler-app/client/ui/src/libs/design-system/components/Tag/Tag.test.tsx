/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { Tag } from "./Tag";

const css = readFileSync(new URL("./Tag.module.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");

function first(markup: string) {
  return new JSDOM(markup).window.document.body.firstElementChild!;
}

function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start));
}

function px(name: string): number {
  const match = new RegExp(`${name}:\\s*([^;]+);`, "u").exec(tokens);
  expect(match).not.toBeNull();
  const value = match![1].trim();
  if (/^\d+px$/u.test(value)) return Number.parseInt(value, 10);
  const ref = /^var\((--[\w-]+)\)$/u.exec(value);
  if (ref) return px(ref[1]);
  const sum = /^calc\(var\((--[\w-]+)\) \+ var\((--[\w-]+)\) \/ 2\)$/u.exec(value);
  if (sum) return px(sum[1]) + px(sum[2]) / 2;
  throw new Error(`unparsed token ${name}: ${value}`);
}

test("Tag sizes: sm by default, md on request", () => {
  expect(first(renderToStaticMarkup(<Tag>Plain</Tag>)).getAttribute("data-size")).toBe("sm");
  expect(first(renderToStaticMarkup(<Tag size="md">Foundations · 196 tokens</Tag>)).getAttribute("data-size")).toBe("md");
});

test("Tag padding and height come from comfortable tag tokens", () => {
  const base = block(css, ".tag");
  expect(base).toContain("min-height: var(--tag-height-sm)");
  expect(base).toContain("padding-inline: var(--tag-padding-inline-sm)");
  const md = block(css, '.tag[data-size="md"]');
  expect(md).toContain("min-height: var(--tag-height-md)");
  expect(md).toContain("padding-inline: var(--tag-padding-inline-md)");
  // ~8-10px for sm, 10-12px for md; heights leave room above the caption.
  expect(px("--tag-padding-inline-sm")).toBeGreaterThanOrEqual(8);
  expect(px("--tag-padding-inline-sm")).toBeLessThanOrEqual(10);
  expect(px("--tag-padding-inline-md")).toBeGreaterThanOrEqual(10);
  expect(px("--tag-padding-inline-md")).toBeLessThanOrEqual(12);
  expect(px("--tag-height-sm")).toBeGreaterThanOrEqual(20);
  expect(px("--tag-height-md")).toBeGreaterThan(px("--tag-height-sm"));
});

test("a removable Tag tightens only its trailing edge around the remove button", () => {
  expect(css).toMatch(/\.tag\[data-removable="true"\]\s*\{\s*padding-inline-end: var\(--space-xs\);/u);
  expect(first(renderToStaticMarkup(<Tag onRemove={() => undefined} removeLabel="Remove">Plan</Tag>)).getAttribute("data-removable")).toBe("true");
});
