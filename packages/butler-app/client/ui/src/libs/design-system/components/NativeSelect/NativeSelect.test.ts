/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./NativeSelect.module.css", import.meta.url), "utf8").replace(/\s+/gu, " ");

test("the select's floor width never exceeds its container; the value truncates instead", () => {
  expect(css).toMatch(/\.wrapper \{[^}]*min-width: min\(160px, 100%\);/u);
  // The trigger's track may shrink below the label's width.
  expect(css).toMatch(/\.wrapper \{[^}]*grid-template-columns: minmax\(0, 1fr\);/u);
  expect(css).toMatch(/\.value \{[^}]*text-overflow: ellipsis;/u);
});

test("the focus ring wraps the control box, never the chevron", () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/gu)].map(([, selector, body]) => ({ selector: selector!.trim(), body: body! }));
  const ringRules = rules.filter((rule) => rule.body.includes("var(--focus-ring)"));
  expect(ringRules.length).toBeGreaterThan(0);
  for (const rule of ringRules) {
    expect(rule.selector).not.toMatch(/\.icon/u);
    expect(rule.selector.split(",").every((part) => part.trim().endsWith(".trigger"))).toBe(true);
  }
  // Keyboard focus only, like Input: the ring follows :focus-visible on the select.
  expect(css).toMatch(/\.wrapper:has\(\.select:focus-visible\) \.trigger \{[^}]*box-shadow: var\(--focus-ring\);/u);
});
