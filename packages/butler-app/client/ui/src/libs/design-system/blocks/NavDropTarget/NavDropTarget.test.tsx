/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { NavDropTarget } from "./NavDropTarget";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/gu, " ");
const css = read("./NavDropTarget.module.css");
const tokens = read("../../tokens.css");

test("the block renders drop state as data attributes and places the indicator without product styles", () => {
  const markup = renderToStaticMarkup(
    <NavDropTarget drop="group" dragging={false} indicator={{ top: 4, height: 30 }} hint="Group together">
      <div>Row</div>
    </NavDropTarget>,
  );
  const item = new JSDOM(markup).window.document.querySelector('[data-slot="nav-drop-target"]')!;
  expect(item.getAttribute("data-drop")).toBe("group");
  expect(item.getAttribute("style")).toContain("--drop-row-top:4px");
  expect(item.querySelector('[data-slot="nav-drop-hint"]')?.textContent).toBe("Group together");
});

test("a drop inside lifts the target with the lift scale, shadow token and spring easing", () => {
  expect(tokens).toContain("--motion-scale-lift: 1.02;");
  expect(tokens).toMatch(/--shadow-drag-lift: [^;]+;/u);
  // Reduced motion resets the lift scale like every other motion scale.
  expect(tokens).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ :root \{[^}]*--motion-scale-lift: 1;/u);
  expect(css).toMatch(/\[data-drop="inside"\][^{]*::before[^{]*\{[^}]*scale: var\(--motion-scale-lift\)/u);
  expect(css).toMatch(/box-shadow: var\(--shadow-drag-lift\)/u);
  expect(css).toMatch(/var\(--motion-ease-spring\)/u);
});

test("before and after drops slide the neighboring rows apart with motion distance tokens", () => {
  expect(css).toMatch(/\.item\[data-drop="before"\] \{[^}]*translate: 0 var\(--motion-distance-xs\)/u);
  expect(css).toMatch(/\.item\[data-drop="after"\] \{[^}]*translate: 0 calc\(-1 \* var\(--motion-distance-xs\)\)/u);
  expect(css).toMatch(/:has\( ?\+ \[data-slot="collapsible-list-item"\] > \.item\[data-drop="before"\] ?\)/u);
  expect(css).toMatch(/:has\(> \.item\[data-drop="after"\]\) \+ \[data-slot="collapsible-list-item"\]/u);
  expect(css).toMatch(/\.item \{[^}]*transition: translate var\(--motion-fast\) var\(--motion-ease-standard\)/u);
});
