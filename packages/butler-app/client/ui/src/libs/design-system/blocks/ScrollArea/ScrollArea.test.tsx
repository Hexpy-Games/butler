/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ScrollArea } from "./ScrollArea";

const css = readFileSync(new URL("./ScrollArea.module.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");

test("minHeight keeps a short scroller at a token floor without inline style", () => {
  const html = renderToStaticMarkup(<ScrollArea minHeight="xs" fill><p>Legend</p></ScrollArea>);
  expect(html).toContain('data-min-height="xs"');
  expect(html).not.toContain("style=");
  expect(css).toMatch(/\.frame\[data-min-height="xs"\]\s*\{\s*min-height:\s*var\(--scroll-area-min-height-xs\);\s*\}/u);
  expect(tokens).toMatch(/--scroll-area-min-height-xs:\s*96px/u);
  expect(readFileSync(new URL("./ScrollArea.tsx", import.meta.url), "utf8")).not.toContain("UNSAFE_style");
});
