/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AspectFrame } from "./AspectFrame";

const css = readFileSync(new URL("./AspectFrame.module.css", import.meta.url), "utf8");

test("AspectFrame is a square, contained frame sized by icon tokens without inline styles", () => {
  const html = renderToStaticMarkup(<AspectFrame size="sm" aria-hidden="true"><canvas /></AspectFrame>);
  expect(html).toContain('data-size="sm"');
  expect(html).not.toContain("style=");
  expect(css).toMatch(/aspect-ratio:\s*1/u);
  expect(css).toMatch(/contain:\s*layout paint size/u);
  expect(css).toMatch(/\[data-size="sm"\]\s*\{\s*width:\s*var\(--icon-size-sm\)/u);
});
