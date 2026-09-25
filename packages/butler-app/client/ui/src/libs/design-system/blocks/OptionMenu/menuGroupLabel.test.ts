/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const rule = (css: string, selector: string) =>
  new RegExp(`${selector.replace(/[.[\]"=-]/gu, "\\$&")}(?:,[^{]*)?\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";

test("menu group labels share one quiet label style, distinct from body-size items", () => {
  const tokens = read("../../tokens.css");
  expect(tokens).toMatch(/--menu-group-label-size:\s*var\(--typo-section-title-size\)/u);
  expect(tokens).toMatch(/--menu-group-label-weight:\s*var\(--font-weight-medium\)/u);
  expect(tokens).toMatch(/--menu-group-label-color:\s*var\(--text-tertiary\)/u);
  const labels = [
    rule(read("./OptionMenu.module.css"), ".sectionTitle"),
    rule(read("../FilteredSelectPopover/FilteredSelectPopover.module.css"), ".groupTitle"),
    rule(read("../../components/DropdownMenu/DropdownMenu.module.css"), ".label"),
  ];
  for (const body of labels) {
    expect(body).toMatch(/font-size:\s*var\(--menu-group-label-size\)/u);
    expect(body).toMatch(/font-weight:\s*var\(--menu-group-label-weight\)/u);
    expect(body).toMatch(/color:\s*var\(--menu-group-label-color\)/u);
  }
  // Items stay at body size so the label reads as a heading, not an option.
  expect(rule(read("./OptionMenu.module.css"), ".label")).toMatch(/font-size:\s*var\(--font-size-3\)/u);
});
