/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { Grid } from "../Grid";
import { PageContainer } from "./PageContainer";

const css = readFileSync(new URL("./PageContainer.module.css", import.meta.url), "utf8");
const gridCss = readFileSync(new URL("../Grid/Grid.module.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");

function render(markup: string) {
  return new JSDOM(markup).window.document.body.firstElementChild!;
}

test("PageContainer renders the requested element with width and gutter attributes", () => {
  const element = render(renderToStaticMarkup(<PageContainer as="main" width="narrow" gutter="lg">x</PageContainer>));
  expect(element.tagName).toBe("MAIN");
  expect(element.getAttribute("data-width")).toBe("narrow");
  expect(element.getAttribute("data-gutter")).toBe("lg");
  expect(element.getAttribute("data-slot")).toBe("page-container");
  const defaults = render(renderToStaticMarkup(<PageContainer>x</PageContainer>));
  expect(defaults.tagName).toBe("DIV");
  expect(defaults.getAttribute("data-width")).toBe("default");
  expect(defaults.hasAttribute("data-gutter")).toBe(false);
});

test("PageContainer is the page inline-size container capped by page width tokens", () => {
  expect(css).toMatch(/container:\s*page\s*\/\s*inline-size/u);
  expect(css).toMatch(/\[data-width="narrow"\][^}]*max-width:\s*var\(--page-container-narrow\)/u);
  expect(css).toMatch(/\[data-width="default"\][^}]*max-width:\s*var\(--page-container-default\)/u);
  expect(css).toMatch(/\[data-width="full"\][^}]*max-width:\s*none/u);
  expect(css).toMatch(/margin-inline:\s*auto/u);
  expect(tokens).toMatch(/--page-container-narrow:\s*var\(--page-max-width-reading\)/u);
  expect(tokens).toMatch(/--page-container-default:\s*var\(--page-max-width-wide\)/u);
});

test("Grid responsive columns switch to the wide preset inside a wide page container", () => {
  const element = render(renderToStaticMarkup(<Grid columns={{ base: "1", wide: "main-aside" }}>x</Grid>));
  expect(element.getAttribute("data-columns")).toBe("1");
  expect(element.getAttribute("data-columns-wide")).toBe("main-aside");
  const fixed = render(renderToStaticMarkup(<Grid columns="2">x</Grid>));
  expect(fixed.hasAttribute("data-columns-wide")).toBe(false);
  expect(gridCss).toMatch(/@container page \(min-width: 48rem\)/u);
  expect(gridCss).toMatch(/\[data-columns-wide="main-aside"\][^}]*grid-template-columns:\s*minmax\(0, 2fr\) minmax\(0, 1fr\)/u);
  expect(gridCss).toMatch(/\[data-columns="1"\][^}]*grid-template-columns:\s*minmax\(0, 1fr\)/u);
  expect(gridCss).toMatch(/minmax\(min\(100%, 240px\), 1fr\)/u);
});
