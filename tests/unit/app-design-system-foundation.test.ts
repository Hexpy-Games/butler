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
