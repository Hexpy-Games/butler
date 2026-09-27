/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { IconSlot } from "./IconSlot";

const css = readFileSync(new URL("./IconSlot.module.css", import.meta.url), "utf8");

test("IconSlot sizes a glyph square from icon tokens and can follow the sidebar density", () => {
  const html = renderToStaticMarkup(<IconSlot size="sidebar" minHeight="line" passive role="status" aria-label="Working">x</IconSlot>);
  expect(html).toContain('data-size="sidebar"');
  expect(html).toContain('data-min-height="line"');
  expect(html).toContain('data-passive="true"');
  expect(html).toContain('role="status"');
  expect(renderToStaticMarkup(<IconSlot tone="secondary">x</IconSlot>)).toContain('data-tone="secondary"');
  expect(css).toMatch(/\[data-size="sidebar"\]\s*\{\s*--icon-slot-size:\s*var\(--sidebar-icon-size/u);
  expect(css).toMatch(/\[data-passive="true"\]\s*\{\s*pointer-events:\s*none/u);
});
