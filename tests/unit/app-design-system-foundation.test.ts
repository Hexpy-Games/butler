import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoOrLedgerPath } from "../support/project-ledger-root.ts";

const root = process.cwd();
const uiSrc = "packages/butler-app/client/ui/src";

function read(path: string): string {
  return readFileSync(resolveRepoOrLedgerPath(path), "utf8");
}

describe("design-system foundation spec", () => {
  test("spec records the Phase 1 foundation contracts", () => {
    const spec = read(
      "project-ledger/projects/butler/specs/butler-dedicated-client-design-system.md",
    );
    for (const heading of [
      "## Scroll Fade Contract",
      "## Tinted Glass Contract",
      "## Theme Parity Contract",
      "## Focus Ring Contract",
      "## Layering Contract",
      "## Control And Menu Sizing Contract",
      "## Locale And Korean Typography Contract",
    ]) {
      expect(spec).toContain(heading);
    }
    expect(spec).toContain("--scroll-fade-size");
    expect(spec).toContain("--focus-ring");
    expect(spec).toContain("--menu-item-height");
    expect(spec).toContain("--z-tooltip");
  });
});


const tokensPath = `${uiSrc}/libs/design-system/tokens.css`;

function tokenBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing selector block ${selector}`);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated selector block ${selector}`);
}

function parseTokens(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
    tokens.set(match[1], match[2].replace(/\s+/gu, " ").trim());
  }
  return tokens;
}

function rootTokens(): Map<string, string> {
  return parseTokens(tokenBlock(read(tokensPath), ":root"));
}

describe("design-system foundation tokens", () => {
  test("defines scroll fade, focus ring, and menu sizing tokens", () => {
    const tokens = rootTokens();
    expect(tokens.get("--scroll-fade-size")).toBe("14px");
    expect(tokens.get("--focus-ring-color")).toBeDefined();
    expect(tokens.get("--focus-ring")).toBe("0 0 0 2px var(--focus-ring-color)");
    expect(tokens.get("--menu-item-height")).toBe("32px");
    expect(tokens.get("--control-height-xs")).toBe("24px");
    expect(tokens.get("--control-height-sm")).toBe("28px");
    expect(tokens.get("--control-height-md")).toBe("30px");
    expect(tokens.get("--control-height-lg")).toBe("34px");
  });

  test("defines an ordered z-index scale with tooltips above dialogs", () => {
    const tokens = rootTokens();
    const order = [
      "--z-sticky",
      "--z-drawer",
      "--z-overlay",
      "--z-dialog",
      "--z-popover",
      "--z-tooltip",
      "--z-drag",
    ];
    const values = order.map((name) => {
      const value = tokens.get(name);
      expect(value).toMatch(/^\d+$/u);
      return Number(value);
    });
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThan(values[index - 1]);
    }
  });
});

function themeTokens(selector: ".theme-light" | ".theme-dark"): Map<string, string> {
  return parseTokens(tokenBlock(read(tokensPath), selector));
}

function resolveToken(name: string, theme: Map<string, string>): string {
  const root = rootTokens();
  let value = theme.get(name) ?? root.get(name);
  for (let depth = 0; value && depth < 10; depth += 1) {
    const reference = /^var\((--[\w-]+)\)$/u.exec(value);
    if (!reference) return value;
    value = theme.get(reference[1]) ?? root.get(reference[1]);
  }
  throw new Error(`cannot resolve ${name}`);
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

describe("design-system theme parity", () => {
  test(":root defaults match the explicit light theme", () => {
    const root = rootTokens();
    const mismatches = [...themeTokens(".theme-light")]
      .filter(([name, value]) => root.has(name) && root.get(name) !== value)
      .map(([name]) => name);
    expect(mismatches).toEqual([]);
  });

  test("every light theme override also exists in the dark theme", () => {
    const dark = themeTokens(".theme-dark");
    const missing = [...themeTokens(".theme-light").keys()].filter((name) => !dark.has(name));
    expect(missing).toEqual([]);
  });

  test("literal shadcn surface aliases are overridden for dark", () => {
    const dark = themeTokens(".theme-dark");
    for (const name of ["--secondary", "--muted"]) {
      expect(dark.get(name)).toBeDefined();
      expect(dark.get(name)).not.toBe(rootTokens().get(name));
    }
  });

  test("light placeholder text keeps 4.5:1 contrast on input surfaces", () => {
    const light = themeTokens(".theme-light");
    for (const theme of [light, new Map<string, string>()]) {
      const placeholder = resolveToken("--placeholder", theme);
      expect(placeholder).toMatch(/^#[0-9a-f]{6}$/u);
      for (const surface of ["#ffffff", resolveToken("--color-surface-base", theme)]) {
        expect(contrast(placeholder, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
