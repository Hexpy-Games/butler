/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../DesignSystemViewer.module.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\s+/gu, " ");
const escape = (selector: string) => selector.replace(/[.*]/gu, (char) => `\\${char}`);
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\}) ?${escape(selector)} \\{([^}]*)\\}`, "u"))?.[1] ?? "";

test("a states matrix is a theme scope that paints its own text color", () => {
  expect(rule(".matrix")).toContain("color: var(--text-primary);");
});

test("a states-matrix cell sizes to the grid, not to its content", () => {
  const cell = rule(".matrixCell");
  expect(cell).toContain("grid-template-columns: minmax(0, 1fr);");
  expect(cell).toContain("container-type: inline-size;");
  expect(rule(".matrixCell > *")).toContain("max-width: 100%;");
});
