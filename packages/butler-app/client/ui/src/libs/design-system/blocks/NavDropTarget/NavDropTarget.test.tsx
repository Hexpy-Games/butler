/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { NavDropScope, NavDropTarget } from "./NavDropTarget";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/gu, " ");
const css = read("./NavDropTarget.module.css");

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

test("group and drop-inside feedback is an inset ring that never changes the target's box", () => {
  const ring = css.match(/\.item\[data-drop="inside"\]::before, \.item\[data-drop="group"\]::before \{([^}]*)\}/u)?.[1] ?? "";
  expect(ring).toContain("box-shadow: inset 0 0 0 var(--border-width-strong) var(--accent)");
  // No scale, border or translate on the target: its layout and hit box stay put.
  expect(ring).not.toMatch(/scale|border:|translate/u);
  expect(css).not.toMatch(/\[data-drop="(?:inside|group)"\][^{]*\{[^}]*(?:scale|translate):/u);
});

test("an insert opens a one-row slot: the target and every later row move down, with a line in the slot", () => {
  expect(css).toMatch(/\.scope \{[^}]*--nav-drop-gap: calc\(var\(--sidebar-row-height\) \+ var\(--nav-drop-spacing\)\)/u);
  // The target of a before drop, the rows after it and the rows after its folders.
  expect(css).toMatch(/:has\(> \.item\[data-drop="before"\]\) > \.item/u);
  expect(css).toMatch(/:has\( ?\.item\[data-drop="before"\], \.item\[data-drop="after"\] ?\) ~ \[data-slot="collapsible-list-item"\] > \.item/u);
  expect(css).toMatch(/translate: 0 var\(--nav-drop-gap\)/u);
  expect(css).toMatch(/\.item \{[^}]*transition: translate var\(--motion-base\) var\(--motion-ease-standard\)/u);
  // Folded rows and sticky folder content let moved rows paint while a drag is active.
  expect(css).toMatch(/\.scope\[data-active="true"\] \{[^}]*--collapsible-clip-margin:/u);
  // Reduced motion: no slot; the line still shows.
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.scope \{ --nav-drop-gap: 0px; \}/u);
});

test("the drop scope marks an active drag", () => {
  const markup = renderToStaticMarkup(<NavDropScope active><div>Rows</div></NavDropScope>);
  const scope = new JSDOM(markup).window.document.querySelector('[data-slot="nav-drop-scope"]')!;
  expect(scope.getAttribute("data-active")).toBe("true");
});

test("folded rows and sticky folder content honor the drag clip margin", () => {
  const collapsible = read("../../components/Collapsible/Collapsible.module.css");
  const group = read("../CollapsibleNavGroup/CollapsibleNavGroup.module.css");
  expect(collapsible).toMatch(/\.collapsible \{[^}]*overflow-clip-margin: var\(--collapsible-clip-margin, 0\)/u);
  expect(group).toMatch(/clip-path: inset\( ?var\(--sticky-clip-top, 0\) 0 calc\(-1 \* var\(--collapsible-clip-margin, 0px\)\)/u);
});
