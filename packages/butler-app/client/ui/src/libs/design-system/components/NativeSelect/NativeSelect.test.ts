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
