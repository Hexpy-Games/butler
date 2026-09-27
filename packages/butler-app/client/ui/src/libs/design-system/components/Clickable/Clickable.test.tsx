/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { Clickable } from "./Clickable";

const css = readFileSync(new URL("./Clickable.module.css", import.meta.url), "utf8").replace(/\s+/gu, " ");

test("the text variant is a bare text target: no row padding or fill, a quieter tone on hover", () => {
  const markup = renderToStaticMarkup(<Clickable variant="text" onClick={() => undefined}>Open source</Clickable>);
  expect(markup).toContain('data-variant="text"');
  expect(markup).toContain('role="button"');
  expect(css).toMatch(/\.clickable\[data-variant="text"\] \{[^}]*padding: 0;[^}]*min-height: 0;/u);
  expect(css).toMatch(/\.clickable\[data-variant="text"\]:hover:not\(\[data-disabled="true"\]\)[^{]*\{[^}]*background: transparent;[^}]*color: var\(--text-secondary\);/u);
});
