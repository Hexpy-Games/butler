/// <reference types="bun" />
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Kbd } from "./Kbd";

test("a key combination renders one nested <kbd> per key inside an outer <kbd>", () => {
  const markup = renderToStaticMarkup(<Kbd keys={["⌘", "K"]} />);
  expect(markup).toMatch(/^<kbd[^>]*data-slot="kbd"/u);
  expect(markup.match(/<kbd/gu)?.length).toBe(3);
  expect(markup).toContain(">⌘</kbd>");
  expect(markup).toContain(">K</kbd>");
});

test("an accessible label replaces symbol keys for assistive technology", () => {
  const markup = renderToStaticMarkup(<Kbd keys={["⌘", "K"]} label="Command K" />);
  expect(markup).toContain('aria-label="Command K"');
});

test("size sm is exposed for compact rows", () => {
  expect(renderToStaticMarkup(<Kbd keys={["/"]} size="sm" />)).toContain('data-size="sm"');
});
