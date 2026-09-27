/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { GlyphToggle } from "./GlyphToggle";

test("GlyphToggle renders a pressed-state icon button over the glyph with both glyphs", () => {
  const document = new JSDOM(renderToStaticMarkup(
    <GlyphToggle glyph={<i data-glyph="row" />} toggleGlyph={<i data-glyph="star" />} pressed label="Pin Butler site" />,
  )).window.document;
  const button = document.querySelector("button")!;
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.getAttribute("aria-label")).toBe("Pin Butler site");
  expect(button.querySelector('[data-glyph="row"]')).not.toBeNull();
  expect(button.querySelector('[data-glyph="star"]')).not.toBeNull();
  expect(document.querySelector('[data-slot="glyph-toggle"]')).not.toBeNull();
});
