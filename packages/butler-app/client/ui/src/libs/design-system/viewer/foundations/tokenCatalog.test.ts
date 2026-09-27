/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildTokenCatalog, parseTokenDefinitions, TOKEN_CATEGORIES, type TokenCategory } from "./tokenCatalog";

const css = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, "");
const definitions = parseTokenDefinitions(css);
const catalog = buildTokenCatalog(definitions);
const byName = new Map(catalog.map((entry) => [entry.name, entry]));

describe("token catalog generated from tokens.css", () => {
  test("parses every custom property definition in the file", () => {
    const declared = withoutComments.match(/(?<![\w-])--[\w-]+\s*:/gu) ?? [];
    expect(definitions.length).toBe(declared.length);
    expect(definitions.length).toBeGreaterThan(700);
  });

  test("records the selector and media context of each definition", () => {
    const hit = definitions.find((definition) => definition.name === "--control-hit-target" && definition.media);
    expect(hit).toMatchObject({ selector: ":root", media: "@media (width <= 640px), (pointer: coarse)", value: "44px" });
    expect(definitions.find((definition) => definition.selector === '[data-sidebar-density="touch"]')).toBeTruthy();
    expect(definitions.find((definition) => definition.name === "--motion-ease-spring")?.value).toMatch(/^linear\(0, 0\.0855/u);
  });

  test("lists every unique token exactly once in a known category", () => {
    const unique = new Set(definitions.map((definition) => definition.name));
    expect(catalog.map((entry) => entry.name).sort()).toEqual([...unique].sort());
    for (const entry of catalog) expect({ name: entry.name, known: TOKEN_CATEGORIES.includes(entry.category) }).toEqual({ name: entry.name, known: true });
  });

  test("puts every color family on the color page", () => {
    for (const name of ["--grayscale-01", "--amber-10", "--color-text-primary", "--color-focus-ring", "--conversation-bg",
      "--placeholder", "--composer-glass-highlight", "--dialog-overlay-bg", "--context-chart-6", "--context-chart-free", "--syntax-keyword"]) {
      expect({ name, category: byName.get(name)?.category }).toEqual({ name, category: "color" });
    }
    expect(byName.get("--grayscale-01")?.group).toBe("Palette");
    expect(byName.get("--color-text-primary")?.group).toBe("Semantic");
    expect(byName.get("--syntax-keyword")?.group).toBe("Syntax");
    expect(byName.get("--context-chart-3")?.group).toBe("Chart");
    expect(byName.get("--tinted-glass-tint")?.group).toBe("Glass");
  });

  test("sorts the other foundations by role", () => {
    const expected: Record<string, TokenCategory> = {
      "--typo-h1-size": "typography", "--font-weight-strong": "typography", "--space-md": "spacing",
      "--radius-panel": "radius", "--shadow-card": "shadow", "--z-popover": "z-index", "--motion-ease-spring": "motion",
      "--motion-distance-lg": "motion", "--spinner-duration": "motion", "--focus-ring": "focus", "--control-height-md": "sizing",
      "--menu-item-height": "sizing", "--icon-size-xl": "sizing", "--settings-field-gap": "settings", "--safe-area-top": "layout",
    };
    for (const [name, category] of Object.entries(expected)) expect({ name, category: byName.get(name)?.category }).toEqual({ name, category });
  });

  test("resolves light and dark values from :root, .theme-light and .theme-dark", () => {
    expect(byName.get("--color-success")).toMatchObject({ light: "var(--green-06)", dark: "var(--green-05)" });
    expect(byName.get("--space-md")).toMatchObject({ light: "12px", dark: null });
    expect(byName.get("--sidebar-row-height")?.overrides.map((override) => override.context))
      .toContain('[data-sidebar-density="touch"]');
  });

  test("marks legacy aliases with a replacement that exists", () => {
    const legacy = catalog.filter((entry) => entry.legacy);
    expect(legacy.map((entry) => entry.name)).toEqual(expect.arrayContaining(["--space-1", "--font-size-3", "--background", "--radius"]));
    expect(byName.get("--space-3")?.legacy?.replacement).toBe("--space-md");
    expect(byName.get("--font-size-1")?.legacy?.replacement).toBe("--typo-caption-size");
    for (const entry of legacy) expect({ name: entry.name, exists: byName.has(entry.legacy!.replacement) }).toEqual({ name: entry.name, exists: true });
    expect(byName.get("--space-md")?.legacy).toBeUndefined();
  });
});
