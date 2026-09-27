/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { OptionMenuItem } from "./OptionMenu";

test("disabledReason keeps the item hoverable (aria-disabled) and inert", () => {
  const html = renderToStaticMarkup(
    <OptionMenuItem label="Attach image" disabledReason="Model doesn't accept images" onClick={() => { throw new Error("clicked"); }} />,
  );
  const item = new JSDOM(html).window.document.querySelector('[data-slot="option-menu-item"]');
  expect(item?.getAttribute("aria-disabled")).toBe("true");
  // Native `disabled` swallows pointer events, so the tooltip could not open.
  expect(item?.hasAttribute("disabled")).toBe(false);
  expect(item?.getAttribute("data-disabled")).toBe("true");
});

test("an item without a reason renders enabled", () => {
  const html = renderToStaticMarkup(<OptionMenuItem label="Attach file" />);
  const item = new JSDOM(html).window.document.querySelector('[data-slot="option-menu-item"]');
  expect(item?.hasAttribute("aria-disabled")).toBe(false);
});

test("the disabled item uses the disabled tone and never takes the hover fill", () => {
  const css = readFileSync(new URL("./OptionMenu.module.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.item\[data-disabled="true"\][^{]*\{[^}]*color:\s*var\(--interactive-disabled-fg\)/u);
  expect(css).toMatch(/\.item\[data-disabled="true"\][^{]*\{[^}]*cursor:\s*var\(--interactive-disabled-cursor\)/u);
  expect(css).toMatch(/\.item:hover:not\(\[data-disabled="true"\]\)/u);
});
