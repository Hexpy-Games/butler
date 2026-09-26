/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const uiRoot = join(import.meta.dir, "..", "..");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

function rules(path: string): Array<{ selector: string; body: string }> {
  const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
}

test("press feedback scales with the scale property, so it composes with transform positioning", () => {
  // `transform: scale()` on :active replaced positioning transforms (GlyphToggle's translate(-50%, -50%),
  // the scroll-to-bottom pill's translateX(50%)) and threw the pressed control down and to the side.
  // `transform: none` (dropping a hover lift on press) is fine.
  const offenders = cssFiles(uiRoot).flatMap((path) => rules(path)
    .filter(({ selector, body }) => /:active\b/u.test(selector) && [...body.matchAll(/(?:^|[;\s])transform\s*:([^;]*)/gu)].some((match) => match[1].trim() !== "none"))
    .map(({ selector }) => `${relative(uiRoot, path)}: ${selector.replace(/\s+/gu, " ")}`));
  expect(offenders).toEqual([]);
  for (const file of ["components/Button/Button.module.css", "components/IconButton/IconButton.module.css", "components/Clickable/Clickable.module.css"]) {
    expect(readFileSync(join(import.meta.dir, file), "utf8")).toContain("scale: var(--motion-scale-press);");
  }
});

test("GlyphToggle centres its hit target with translate, which press scale no longer replaces", () => {
  const css = readFileSync(join(import.meta.dir, "components/GlyphToggle/GlyphToggle.module.css"), "utf8");
  expect(css).toMatch(/\.toggle \{[^}]*translate: -50% -50%;/u);
  expect(css).not.toMatch(/transform:/u);
});
