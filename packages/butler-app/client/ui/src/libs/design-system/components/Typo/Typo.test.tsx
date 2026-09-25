/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { Typo } from "./Typo";

const css = readFileSync(new URL("./Typo.module.css", import.meta.url), "utf8");

function render(node: React.ReactElement): HTMLElement {
  const dom = new JSDOM(renderToStaticMarkup(node));
  const element = dom.window.document.body.firstElementChild as HTMLElement | null;
  if (!element) throw new Error("nothing rendered");
  return element;
}

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css);
  if (!match) throw new Error(`missing CSS rule ${selector}`);
  return match[1];
}

test("variants without text props render no text-prop attributes and keep inheriting color", () => {
  const element = render(<Typo.Body>Plain</Typo.Body>);
  expect(element.tagName).toBe("P");
  for (const name of ["data-tone", "data-weight", "data-align", "data-truncate", "data-line-clamp", "data-wrap", "data-numeric"]) {
    expect(element.hasAttribute(name)).toBe(false);
  }
  expect(rule(".body")).not.toMatch(/(?:^|[\s;])color\s*:/u);
});

test("every variant accepts the text props as data attributes", () => {
  for (const Variant of [Typo.Body, Typo.Caption, Typo.Label, Typo.Code, Typo.PanelTitle, Typo.MetricValue, Typo.Text]) {
    const element = render(
      <Variant tone="secondary" weight="medium" align="end" truncate numeric="tabular">Value</Variant>,
    );
    expect(element.getAttribute("data-tone")).toBe("secondary");
    expect(element.getAttribute("data-weight")).toBe("medium");
    expect(element.getAttribute("data-align")).toBe("end");
    expect(element.getAttribute("data-truncate")).toBe("true");
    expect(element.getAttribute("data-numeric")).toBe("tabular");
  }
  const clamped = render(<Typo.Caption lineClamp={3} wrap="anywhere">Long</Typo.Caption>);
  expect(clamped.getAttribute("data-line-clamp")).toBe("3");
  expect(clamped.getAttribute("data-wrap")).toBe("anywhere");
});

test("tones map to semantic text tokens", () => {
  const tokens: Record<string, string> = {
    primary: "--color-text-primary",
    secondary: "--color-text-secondary",
    tertiary: "--color-text-tertiary",
    disabled: "--color-text-disabled",
    danger: "--color-danger-text",
    success: "--color-success-text",
    warning: "--color-warning-text",
  };
  for (const [tone, token] of Object.entries(tokens)) {
    expect(rule(`[data-tone="${tone}"]`)).toContain(`color: var(${token})`);
  }
  expect(rule('[data-tone="inherit"]')).toContain("color: inherit");
});

test("weights, alignment, wrapping, clamp and numerals use tokens or keywords", () => {
  expect(rule('[data-weight="regular"]')).toContain("var(--font-weight-regular)");
  expect(rule('[data-weight="medium"]')).toContain("var(--font-weight-medium)");
  expect(rule('[data-weight="semibold"]')).toContain("var(--font-weight-semibold)");
  expect(rule('[data-align="end"]')).toContain("text-align: end");
  expect(rule('[data-truncate="true"]')).toMatch(/text-overflow:\s*ellipsis/u);
  expect(rule('[data-truncate="true"]')).toMatch(/white-space:\s*nowrap/u);
  expect(rule('[data-truncate="true"]')).toMatch(/min-width:\s*0/u);
  expect(rule('[data-wrap="nowrap"]')).toMatch(/white-space:\s*nowrap/u);
  expect(rule('[data-wrap="anywhere"]')).toMatch(/overflow-wrap:\s*anywhere/u);
  expect(rule("[data-line-clamp]")).toMatch(/-webkit-box-orient:\s*vertical/u);
  expect(rule('[data-line-clamp="2"]')).toMatch(/line-clamp:\s*2/u);
  expect(rule('[data-numeric="tabular"]')).toMatch(/font-variant-numeric:\s*tabular-nums/u);
});

test("Typo.Text inherits the container type scale", () => {
  const element = render(<Typo.Text>Inline</Typo.Text>);
  expect(element.tagName).toBe("SPAN");
  expect(rule(".text")).not.toMatch(/font-size|font-weight|line-height/u);
});

test("time elements pass dateTime through", () => {
  const element = render(
    <Typo.Text as="time" dateTime="2026-09-25T04:25:00.000Z" numeric="tabular">1:25 PM</Typo.Text>,
  );
  expect(element.tagName).toBe("TIME");
  expect(element.getAttribute("datetime")).toBe("2026-09-25T04:25:00.000Z");
});
