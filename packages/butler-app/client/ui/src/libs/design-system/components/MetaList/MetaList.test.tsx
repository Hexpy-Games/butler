/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { MetaList } from "./MetaList";

const css = readFileSync(new URL("./MetaList.module.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

test("MetaList renders label/value pairs as a description list with readable spacing", () => {
  const markup = renderToStaticMarkup(
    <MetaList items={[
      { label: "Input", value: "36,460" },
      { label: "Cache", value: "8,200" },
      { value: "Local telemetry" },
    ]} />,
  );
  const document = new JSDOM(markup).window.document;
  const list = document.querySelector("dl");
  expect(list).not.toBeNull();
  const items = Array.from(list!.children);
  expect(items.map((item) => item.textContent)).toEqual(["Input 36,460", "Cache 8,200", "Local telemetry"]);
  expect(items[0]!.querySelector("dt")?.textContent).toBe("Input");
  expect(items[0]!.querySelector("dd")?.textContent).toBe("36,460");
  expect(items[2]!.querySelector("dt")).toBeNull();
});

test("MetaList spacing and tone come from DS tokens", () => {
  // Wrapped lines sit --space-xs apart, pairs in a line --space-md apart.
  expect(rule(".list")).toContain("gap: var(--space-xs) var(--space-md)");
  expect(rule(".list")).toContain("font-size: var(--typo-caption-size)");
  expect(rule(".item")).toContain("gap: var(--space-xs)");
  expect(rule(".label")).toContain("color: var(--text-tertiary)");
  expect(rule(".value")).toContain("color: var(--text-secondary)");
  expect(rule(".value")).toContain("font-variant-numeric: tabular-nums");
});
