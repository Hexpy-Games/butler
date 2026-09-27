/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressMeter } from "../../blocks/ProgressMeter";
import { Tag } from "../Tag";
import { Box } from "./Box";

const boxCss = readFileSync(new URL("./Box.module.css", import.meta.url), "utf8");
const tagCss = readFileSync(new URL("../Tag/Tag.module.css", import.meta.url), "utf8");
const meterCss = readFileSync(new URL("../../blocks/ProgressMeter/ProgressMeter.module.css", import.meta.url), "utf8");

function dom(markup: string) {
  return new JSDOM(markup).window.document;
}

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css);
  if (!match) throw new Error(`missing CSS rule ${selector}`);
  return match[1];
}

test("Box renders padding, radius, surface and border as data attributes plus item props", () => {
  const element = dom(renderToStaticMarkup(
    <Box as="section" padding="md" paddingX="lg" paddingY="sm" radius="control" surface="raised" border="hairline" grow>x</Box>,
  )).body.firstElementChild!;
  expect(element.tagName).toBe("SECTION");
  expect(element.getAttribute("data-padding")).toBe("md");
  expect(element.getAttribute("data-padding-x")).toBe("lg");
  expect(element.getAttribute("data-padding-y")).toBe("sm");
  expect(element.getAttribute("data-radius")).toBe("control");
  expect(element.getAttribute("data-surface")).toBe("raised");
  expect(element.getAttribute("data-border")).toBe("hairline");
  expect(element.getAttribute("data-grow")).toBe("true");
  expect(element.hasAttribute("data-tone")).toBe(false);
});

test("Box styles come from spacing, radius, surface and border tokens", () => {
  expect(rule(boxCss, '[data-padding="md"]')).toContain("padding: var(--space-md)");
  expect(rule(boxCss, '[data-padding-x="lg"]')).toContain("padding-inline: var(--space-lg)");
  expect(rule(boxCss, '[data-padding-y="sm"]')).toContain("padding-block: var(--space-sm)");
  expect(rule(boxCss, '[data-radius="panel"]')).toContain("border-radius: var(--radius-panel)");
  expect(rule(boxCss, '[data-surface="raised"]')).toContain("background: var(--surface-raised)");
  expect(rule(boxCss, '[data-border="hairline"]')).toContain("var(--border-hairline) solid var(--line)");
  expect(rule(boxCss, '[data-border="strong"]')).toContain("var(--border-width-strong) solid var(--line-strong)");
  expect(boxCss).not.toMatch(/\d+px/u);
});

test("Tag carries a tone, an xs icon slot and an optional remove button", () => {
  const document = dom(renderToStaticMarkup(
    <Tag tone="accent" icon={<svg />} onRemove={() => undefined} removeLabel="Remove plan">Plan</Tag>,
  ));
  const tag = document.body.firstElementChild!;
  expect(tag.getAttribute("data-tone")).toBe("accent");
  expect(document.querySelector("svg")).not.toBeNull();
  const remove = document.querySelector("button");
  expect(remove?.getAttribute("aria-label")).toBe("Remove plan");
  expect(dom(renderToStaticMarkup(<Tag>Plain</Tag>)).body.firstElementChild!.getAttribute("data-tone")).toBe("neutral");
  expect(tagCss).toContain("var(--icon-size-xs)");
  expect(tagCss).not.toMatch(/\b11px\b/u);
});

test("ProgressMeter bare renders only a labelled track", () => {
  const document = dom(renderToStaticMarkup(<ProgressMeter bare value={40} ariaLabel="Changes" />));
  const bar = document.querySelector('[role="progressbar"]');
  expect(bar?.getAttribute("aria-label")).toBe("Changes");
  expect(bar?.getAttribute("aria-valuenow")).toBe("40");
  expect(document.body.textContent).toBe("");
  expect(document.body.firstElementChild?.getAttribute("data-bare")).toBe("true");
  expect(rule(meterCss, '[data-bare="true"] .track')).toContain("height: var(--space-xs)");
});
