/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { SplitBrowser } from "./SplitBrowser";

const css = readFileSync(new URL("./SplitBrowser.module.css", import.meta.url), "utf8");

test("SplitBrowser renders a nav pane and a content pane in one surface without inline styles", () => {
  const document = new JSDOM(renderToStaticMarkup(
    <SplitBrowser data-test-class="specs" nav={<span>Design</span>}><span>Spec A</span></SplitBrowser>,
  )).window.document;
  const root = document.querySelector('[data-test-class="specs"]')!;
  expect(root.getAttribute("data-slot")).toBe("split-browser");
  expect(root.textContent).toBe("DesignSpec A");
  expect(document.body.innerHTML).not.toContain("style=");
  expect(css).toMatch(/grid-template-columns:\s*minmax\(12rem, 0\.34fr\) minmax\(0, 1fr\)/u);
  expect(css).toMatch(/height:\s*var\(--split-browser-height\)/u);
});
