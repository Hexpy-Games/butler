import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lintDesignSystemRules } from "../../packages/butler-app/scripts/lint/design-system-rules-lint.ts";

const uiSrc = "packages/butler-app/client/ui/src";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

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

function compositeOver(rgba: string, backgroundHex: string, coverage = 1): string {
  const match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/u.exec(rgba);
  if (!match) throw new Error(`expected rgba(), got ${rgba}`);
  const alpha = Number(match[4]) * coverage;
  const background = [1, 3, 5].map((index) => Number.parseInt(backgroundHex.slice(index, index + 2), 16));
  return `#${background.map((channel, index) =>
    Math.round(alpha * Number(match[index + 1]) + (1 - alpha) * channel).toString(16).padStart(2, "0")).join("")}`;
}

describe("dark placeholder contrast", () => {
  test("dark placeholder text keeps 4.5:1 contrast on base, input and panel surfaces", () => {
    const dark = themeTokens(".theme-dark");
    const placeholder = resolveToken("--placeholder", dark);
    const base = resolveToken("--color-surface-base", dark);
    expect(placeholder).toMatch(/^#[0-9a-f]{6}$/u);
    const surfaces = [
      base,
      // Input and Textarea paint surface-raised at 92% over the base.
      compositeOver(resolveToken("--color-surface-raised", dark), base, 0.92),
      compositeOver(resolveToken("--settings-panel-bg", dark), base),
    ];
    for (const surface of surfaces) {
      expect(contrast(placeholder, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("secondary button contrast", () => {
  test("root aliases of theme tokens are re-declared on the theme scopes", () => {
    // A var() alias is computed where it is declared: one declared only on
    // :root keeps its light value inside .theme-dark (the dark Deny text).
    const root = rootTokens();
    const dark = themeTokens(".theme-dark");
    const aliases = parseTokens(tokenBlock(read(tokensPath), ".theme-dark,\n.theme-light"));
    const varies = (name: string, depth = 0): boolean =>
      depth < 8 && (dark.has(name) || [...(root.get(name) ?? "").matchAll(/var\((--[\w-]+)/gu)].some((match) => varies(match[1], depth + 1)));
    const frozen = [...root].filter(([name, value]) =>
      !dark.has(name) && !aliases.has(name) &&
      [...value.matchAll(/var\((--[\w-]+)/gu)].some((match) => varies(match[1])));
    expect(frozen.map(([name]) => name)).toEqual([]);
    expect(aliases.get("--secondary-foreground")).toBe("var(--text-primary)");
  });
});
describe("design-system focus ring", () => {
  test("focus ring color keeps 3:1 contrast on base surfaces in both themes", () => {
    for (const theme of [themeTokens(".theme-light"), themeTokens(".theme-dark")]) {
      const ring = resolveToken("--focus-ring-color", theme);
      const surface = resolveToken("--color-surface-base", theme);
      expect(ring).toMatch(/^#[0-9a-f]{6}$/u);
      expect(contrast(ring, surface)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("design-system rules lint", () => {
  test("flags outline:none in :focus-visible without the focus ring", () => {
    const findings = lintDesignSystemRules(
      "sample.module.css",
      ".a:focus-visible { outline: none; }\n.b:focus-visible { outline: none; box-shadow: var(--focus-ring); }\n.c:hover { outline: none; }",
    );
    expect(findings.map((finding) => finding.line)).toEqual([1]);
  });
});

describe("design-system layering", () => {
  test("lint requires z-index tokens for stacking values of 50 and above", () => {
    const findings = lintDesignSystemRules(
      "sample.module.css",
      ".a { z-index: 90; }\n.b { z-index: 12; }\n.c { z-index: var(--z-popover); }\n.d { z-index: calc(var(--z-drawer) - 5); }",
    );
    expect(findings.map((finding) => finding.line)).toEqual([1]);
  });
});

describe("design-system control and menu sizing", () => {
  test("lint rejects raw px heights in control and menu CSS", () => {
    const sample = ".a { height: 30px; }\n.b { min-height: 31px; }\n.c { height: 1px; }\n.d { min-height: var(--menu-item-height); }";
    const findings = lintDesignSystemRules(
      "packages/butler-app/client/ui/src/libs/design-system/components/Select/Select.module.css",
      sample,
    );
    expect(findings.map((finding) => finding.line)).toEqual([1, 2]);
    expect(lintDesignSystemRules("other.module.css", sample)).toEqual([]);
  });
});

describe("design-system syntax highlight tokens", () => {
  const names = [
    "--syntax-keyword",
    "--syntax-string",
    "--syntax-comment",
    "--syntax-number",
    "--syntax-title",
    "--syntax-type",
    "--syntax-variable",
    "--syntax-meta",
    "--syntax-addition",
    "--syntax-deletion",
  ];
  test("syntax colors keep readable contrast on the code surface", () => {
    for (const [theme, surface] of [
      [themeTokens(".theme-light"), "#ffffff"],
      [themeTokens(".theme-dark"), resolveToken("--color-surface-base", themeTokens(".theme-dark"))],
    ] as const) {
      for (const name of names) {
        expect(contrast(resolveToken(name, theme), surface)).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
describe("motion tokens", () => {
  test("lint rejects raw transition and animation timings", () => {
    const raw = lintDesignSystemRules("x.module.css", ".a { transition: opacity 120ms ease; }");
    expect(raw.map((finding) => finding.reason).join("\n")).toContain("--motion-");
    const curve = lintDesignSystemRules(
      "x.module.css",
      ".a { transition: transform var(--motion-base) cubic-bezier(0.2, 0.8, 0.2, 1); }",
    );
    expect(curve).toHaveLength(1);
    const delayed = lintDesignSystemRules("x.module.css", ".a { transition: visibility 0s linear 120ms; }");
    expect(delayed).toHaveLength(1);
    expect(lintDesignSystemRules(
      "x.module.css",
      ".a { transition: opacity var(--motion-fast) var(--motion-ease-standard), visibility 0s var(--motion-ease-linear) var(--motion-fast); animation: spin var(--spinner-duration) var(--motion-ease-linear) infinite; }",
    )).toEqual([]);
  });
});
describe("spacing and radius lint", () => {
  const lint = (css: string, path = "libs/design-system/blocks/New/New.module.css") =>
    lintDesignSystemRules(path, css).map((finding) => finding.reason);

  test("on-scale raw spacing and radius must use tokens", () => {
    expect(lint(".a { padding: 8px var(--space-md); }").join("\n")).toContain("--space-");
    expect(lint(".a { gap: 16px; }")).toHaveLength(1);
    expect(lint(".a { border-radius: 8px; }").join("\n")).toContain("--radius-");
  });

  test("off-scale values need an allow-listed justification", () => {
    expect(lint(".a { margin-top: 10px; }").join("\n")).toContain("off-scale");
    expect(lint(".a { border-radius: 18px; }").join("\n")).toContain("off-scale");
  });

  test("hairline offsets and token values pass", () => {
    expect(lint(".a { gap: 2px; margin: 0; padding: 1px 3px; }")).toEqual([]);
    expect(lint(
      ".a { padding: var(--space-sm) var(--space-lg); border-radius: var(--radius-control); }",
    )).toEqual([]);
  });
});

// test-category: pure-logic
test("dark secondary buttons keep a 3:1 boundary and 4.5:1 text on base, raised and composer surfaces", () => {
    const dark = themeTokens(".theme-dark");
    const base = resolveToken("--color-surface-base", dark);
    const surfaces = [
      base,
      compositeOver(resolveToken("--color-surface-raised", dark), base),
      compositeOver(resolveToken("--composer-glass-bg", dark), base),
    ];
    const border = resolveToken("--secondary-border", dark);
    const text = resolveToken("--secondary-foreground", dark);
    for (const surface of surfaces) {
      const fill = compositeOver(resolveToken("--secondary", dark), surface);
      expect(contrast(compositeOver(border, fill), surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
    }
  });

// test-category: pure-logic
describe("notice tones follow the theme", () => {
  const noticeCss = () => read(`${uiSrc}/libs/design-system/blocks/Notice/Notice.module.css`);
  const toneToken = (block: string, property: string) => {
    const match = new RegExp(`(?<![\\w-])${property}:\\s*var\\((--[\\w-]+)\\);`, "u").exec(block);
    if (!match) throw new Error(`missing ${property} token`);
    return match[1];
  };
  test("each tone is overridden in both themes and stays dark with 4.5:1 text in dark", () => {
    const dark = themeTokens(".theme-dark");
    const light = themeTokens(".theme-light");
    const base = resolveToken("--color-surface-base", dark);
    for (const tone of ["info", "warning", "error", "success"]) {
      const block = tokenBlock(noticeCss(), `.tone-${tone}`);
      const tokens = ["background", "border-color", "color"].map((property) => toneToken(block, property));
      for (const name of tokens) {
        expect({ tone, name, dark: dark.has(name), light: light.has(name) })
          .toEqual({ tone, name, dark: true, light: true });
      }
      const background = compositeOver(resolveToken(tokens[0], dark), base);
      const text = resolveToken(tokens[2], dark);
      expect(luminance(background)).toBeLessThan(0.05);
      expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
