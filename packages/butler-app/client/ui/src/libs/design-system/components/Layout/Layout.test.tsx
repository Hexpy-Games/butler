/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { Grid } from "../Grid";
import { Inline } from "../Inline";
import { Stack } from "../Stack";
import { Typo } from "../Typo";

const itemCss = readFileSync(new URL("./itemProps.module.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");

function render(node: React.ReactElement): HTMLElement {
  const element = new JSDOM(renderToStaticMarkup(node)).window.document.body.firstElementChild;
  if (!element) throw new Error("nothing rendered");
  return element as HTMLElement;
}

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(itemCss);
  if (!match) throw new Error(`missing CSS rule ${selector}`);
  return match[1];
}

test("Stack, Typo and the Item wrappers render layout item props as data attributes", () => {
  const stack = render(<Stack grow shrink={false} basis="md" minWidth="0" alignSelf="center">x</Stack>);
  expect(stack.getAttribute("data-grow")).toBe("true");
  expect(stack.getAttribute("data-shrink")).toBe("false");
  expect(stack.getAttribute("data-basis")).toBe("md");
  expect(stack.getAttribute("data-min-width")).toBe("0");
  expect(stack.getAttribute("data-align-self")).toBe("center");

  const text = render(<Typo.Body grow minWidth="0">x</Typo.Body>);
  expect(text.getAttribute("data-grow")).toBe("true");
  expect(text.getAttribute("data-min-width")).toBe("0");

  const item = render(<Stack.Item basis="lg" shrink>x</Stack.Item>);
  expect(item.tagName).toBe("DIV");
  expect(item.getAttribute("data-basis")).toBe("lg");
  expect(item.getAttribute("data-shrink")).toBe("true");

  const cell = render(<Grid.Item as="section" span="full">x</Grid.Item>);
  expect(cell.tagName).toBe("SECTION");
  expect(cell.getAttribute("data-span")).toBe("full");
});

test("plain Stack renders no item attributes", () => {
  const stack = render(<Stack>x</Stack>);
  for (const name of ["data-grow", "data-shrink", "data-basis", "data-min-width", "data-align-self", "data-span"]) {
    expect(stack.hasAttribute(name)).toBe(false);
  }
});

test("item prop CSS maps to flex/grid properties and basis tokens", () => {
  expect(rule('[data-grow="true"]')).toMatch(/flex-grow:\s*1/u);
  expect(rule('[data-shrink="false"]')).toMatch(/flex-shrink:\s*0/u);
  expect(rule('[data-basis="content"]')).toMatch(/flex-basis:\s*content/u);
  for (const size of ["xs", "sm", "md", "lg"]) {
    expect(rule(`[data-basis="${size}"]`)).toContain(`flex-basis: var(--layout-basis-${size})`);
    expect(tokens).toMatch(new RegExp(`--layout-basis-${size}:\\s*\\d`, "u"));
  }
  expect(rule('[data-min-width="0"]')).toMatch(/min-width:\s*0/u);
  expect(rule('[data-align-self="center"]')).toMatch(/align-self:\s*center/u);
  expect(rule('[data-span="2"]')).toMatch(/grid-column:\s*span 2/u);
  expect(rule('[data-span="full"]')).toMatch(/grid-column:\s*1 \/ -1/u);
});

test("Inline is a wrapping, centered row with a small default gap", () => {
  const html = renderToStaticMarkup(<Inline><span>a</span></Inline>);
  const row = renderToStaticMarkup(<Stack align="row" cross="center" gap="sm" wrap><span>a</span></Stack>);
  expect(html).toBe(row);
  const noWrap = renderToStaticMarkup(<Inline wrap={false} gap="xs"><span>a</span></Inline>);
  expect(noWrap).toBe(renderToStaticMarkup(<Stack align="row" cross="center" gap="xs"><span>a</span></Stack>));
});

test("numeric gap aliases are gone from UI source", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx$/u.test(entry) && !entry.endsWith(".test.tsx")) {
        const source = readFileSync(path, "utf8");
        if (/\bgap=(?:"[1-6]"|\{"[1-6]"\})/u.test(source)) offenders.push(path.slice(root.length));
      }
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
  for (const component of ["../Stack/Stack.tsx", "../Grid/Grid.tsx"]) {
    const source = readFileSync(new URL(component, import.meta.url), "utf8");
    expect(source).not.toMatch(/\|\s*"1"\s*\|\s*"2"/u);
  }
});

test("Stack and Inline take a separate rowGap on the named spacing scale", () => {
  const inline = render(<Inline gap="lg" rowGap="sm">x</Inline>);
  expect(inline.getAttribute("data-row-gap")).toBe("sm");
  expect(render(<Inline gap="lg">x</Inline>).hasAttribute("data-row-gap")).toBe(false);
  expect(render(<Stack rowGap="xs">x</Stack>).getAttribute("data-row-gap")).toBe("xs");
  const stackCss = readFileSync(new URL("../Stack/Stack.module.css", import.meta.url), "utf8");
  for (const step of ["none", "xs", "sm", "md", "lg", "xl", "2xl"]) {
    const escaped = `.stack[data-row-gap="${step}"]`.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(stackCss);
    expect(match?.[1], step).toContain(`row-gap: var(--space-${step})`);
  }
  // Row gaps are declared after the gap shorthand so they win at equal specificity.
  expect(stackCss.indexOf("[data-row-gap=")).toBeGreaterThan(stackCss.indexOf(".gap-2xl"));
});
