/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { InspectorInset } from "./InspectorInset";

test("InspectorInset aligns content with the inspector's inline padding", () => {
  const css = readFileSync(new URL("./InspectorShell.module.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.inset\s*\{[^}]*padding-inline:\s*var\(--inspector-inline-padding\)/u);
  expect(renderToStaticMarkup(<InspectorInset>x</InspectorInset>)).not.toContain("data-fill");
  expect(renderToStaticMarkup(<InspectorInset fill>x</InspectorInset>)).toContain('data-fill="true"');
  expect(css).toMatch(/\.inset\[data-fill="true"\]\s*\{[^}]*flex:\s*1 1 auto/u);
});
