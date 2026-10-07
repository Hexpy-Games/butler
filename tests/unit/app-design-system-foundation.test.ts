import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAppCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { lintDesignSystemRules } from "../../packages/butler-app/scripts/lint/design-system-rules-lint.ts";

const uiSrc = "packages/butler-app/client/ui/src";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function walkUiSources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walkUiSources(path);
    return /\.(?:tsx?|css)$/u.test(entry) ? [path] : [];
  });
}

describe("design-system foundation spec", () => {
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
    expect(tokens.get("--focus-ring-width")).toBe("2px");
    expect(tokens.get("--focus-ring")).toBe(
      "0 0 0 var(--focus-ring-width) var(--focus-ring-color)",
    );
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

  test("the secondary variant draws its boundary from the token", () => {
    const css = read(`${uiSrc}/libs/design-system/components/Button/Button.module.css`);
    expect(tokenBlock(css, ".variantSecondary")).toContain("var(--secondary-border)");
  });
});

describe("notice tones follow the theme", () => {
  const noticeCss = () => read(`${uiSrc}/libs/design-system/blocks/Notice/Notice.module.css`);
  const toneToken = (block: string, property: string) => {
    const match = new RegExp(`(?<![\\w-])${property}:\\s*var\\((--[\\w-]+)\\);`, "u").exec(block);
    if (!match) throw new Error(`missing ${property} token`);
    return match[1];
  };

  test("notice tones use semantic status tokens, not raw palette steps", () => {
    expect(noticeCss()).not.toMatch(/var\(--(?:blue|green|red|amber)-\d+\)/u);
  });

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

describe("design-system focus ring", () => {
  test("focus ring color keeps 3:1 contrast on base surfaces in both themes", () => {
    for (const theme of [themeTokens(".theme-light"), themeTokens(".theme-dark")]) {
      const ring = resolveToken("--focus-ring-color", theme);
      const surface = resolveToken("--color-surface-base", theme);
      expect(ring).toMatch(/^#[0-9a-f]{6}$/u);
      expect(contrast(ring, surface)).toBeGreaterThanOrEqual(3);
    }
  });

  test("legacy ring tokens alias the single focus ring color", () => {
    const blocks = [rootTokens(), themeTokens(".theme-light"), themeTokens(".theme-dark")];
    for (const tokens of blocks) {
      for (const alias of ["--ring", "--color-focus-ring"]) {
        const value = tokens.get(alias);
        if (value !== undefined) expect(value).toBe("var(--focus-ring-color)");
      }
    }
    expect(rootTokens().get("--ring")).toBe("var(--focus-ring-color)");
  });

  test("a shared :focus-visible rule draws the 2px ring", () => {
    expect(read(tokensPath)).toMatch(
      /:where\(:focus-visible\)\s*\{[^}]*outline:\s*var\(--focus-ring-width\) solid var\(--focus-ring-color\)/u,
    );
  });

  test("core controls consume --focus-ring in their :focus-visible rules", () => {
    for (const file of [
      "components/Button/Button.module.css",
      "components/IconButton/IconButton.module.css",
      "components/Input/Input.module.css",
      "components/Textarea/Textarea.module.css",
      "components/Select/Select.module.css",
      "components/NativeSelect/NativeSelect.module.css",
      "components/Card/Card.module.css",
      "blocks/WorkActivityBlock/WorkActivityBlock.module.css",
    ]) {
      const css = read(`${uiSrc}/libs/design-system/${file}`);
      const focusRules = [...css.matchAll(/([^{}]*:focus-visible[^{}]*)\{([^{}]*)\}/gu)];
      expect(`${file}: ${focusRules.some((rule) => rule[2].includes("var(--focus-ring)"))}`).toBe(`${file}: true`);
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

  test("the UI source tree passes the design-system rules lint", () => {
    const result = spawnSync("bun", ["run", "packages/butler-app/scripts/lint/design-system-rules-lint.ts"], {
      encoding: "utf8",
    });
    expect(`${result.status}\n${result.stderr}`).toBe("0\n");
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

  test("overlay primitives use the z-scale so tooltips sit above dialogs", () => {
    const expectations: Array<[string, string]> = [
      ["libs/design-system/shadcn/ui/tooltip.module.css", "var(--z-tooltip)"],
      ["libs/design-system/components/Dialog/Dialog.module.css", "var(--z-dialog)"],
      ["libs/design-system/components/Dialog/Dialog.module.css", "var(--z-overlay)"],
      ["libs/design-system/components/DropdownMenu/DropdownMenu.module.css", "var(--z-popover)"],
      ["libs/design-system/components/ContextMenu/ContextMenu.module.css", "var(--z-popover)"],
      ["libs/design-system/components/Popover/Popover.module.css", "var(--z-popover)"],
      ["libs/design-system/components/Select/Select.module.css", "var(--z-popover)"],
    ];
    for (const [file, token] of expectations) {
      expect(`${file}: ${read(`${uiSrc}/${file}`).includes(`z-index: ${token}`)}`).toBe(`${file}: true`);
    }
  });
});

describe("design-system control and menu sizing", () => {
  const menuFamilies = [
    "components/DropdownMenu/DropdownMenu.module.css",
    "components/ContextMenu/ContextMenu.module.css",
    "components/Select/Select.module.css",
    "blocks/OptionMenu/OptionMenu.module.css",
    "blocks/FilteredSelectPopover/FilteredSelectPopover.module.css",
  ];

  test("menu rows resolve to an exact integer 32px height", () => {
    const tokens = rootTokens();
    const padding = Number.parseFloat(tokens.get("--menu-item-padding-block") ?? "");
    expect(tokens.get("--menu-item-line-height")?.replace(/\(\s+/gu, "(").replace(/\s+\)/gu, ")")).toBe(
      "calc(var(--menu-item-height) - 2 * var(--menu-item-padding-block))",
    );
    const lineHeight = 32 - 2 * padding;
    expect(Number.isInteger(padding) && Number.isInteger(lineHeight) && lineHeight > 0).toBe(true);
  });

  test("every menu family uses the shared menu row sizing", () => {
    for (const file of menuFamilies) {
      const css = read(`${uiSrc}/libs/design-system/${file}`);
      const item = /(?:^|\n)\.item \{([^}]*)\}/u.exec(css)?.[1] ?? "";
      for (const declaration of [
        "min-height: var(--menu-item-height)",
        "padding-block: var(--menu-item-padding-block)",
        "line-height: var(--menu-item-line-height)",
      ]) {
        expect(`${file}: ${item.includes(declaration)}`).toBe(`${file}: true`);
      }
    }
  });

  test("Button and IconButton heights come from control-height tokens", () => {
    const button = read(`${uiSrc}/libs/design-system/components/Button/Button.module.css`);
    for (const size of ["xs", "sm", "md", "lg"]) {
      expect(button).toContain(`height: var(--control-height-${size})`);
    }
    expect(read(`${uiSrc}/libs/design-system/components/IconButton/IconButton.module.css`)).toContain(
      "var(--icon-button-size, var(--control-height-md))",
    );
  });

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

  test("syntax tokens exist in :root, light, and dark themes", () => {
    const root = rootTokens();
    const light = themeTokens(".theme-light");
    const dark = themeTokens(".theme-dark");
    for (const name of names) {
      expect(root.get(name)).toBeDefined();
      expect(light.get(name)).toBe(root.get(name));
      expect(dark.get(name)).toBeDefined();
      expect(dark.get(name)).not.toBe(light.get(name));
    }
  });

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

  test("code block highlight classes consume only syntax tokens", () => {
    const css = read(`${uiSrc}/libs/design-system/blocks/MarkdownContent/MarkdownContent.module.css`);
    expect(css).toContain('[data-syntax="keyword"]');
    expect(css).not.toContain(":global(");
    const colors = [...css.matchAll(/color:\s*([^;]+);/gu)].map((match) => match[1]);
    const syntaxColors = colors.filter((value) => value.includes("--syntax-"));
    expect(syntaxColors.length).toBeGreaterThanOrEqual(names.length);
  });
});

describe("navigation row selection", () => {
  const css = () => read(`${uiSrc}/libs/design-system/blocks/NavRow/NavRow.module.css`);
  const rule = (source: string, selector: string) => {
    const start = source.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf("}", start));
  };

  test("selected rows are clearly stronger than hover", () => {
    const source = css();
    // Disabled rows never take the hover fill (DS disabled tone).
    const hover = rule(source, ".interactive:where(:not(.disabled)):hover");
    const hoverMix = /var\(--selection\)\s+(\d+)%/u.exec(hover);
    expect(hoverMix).not.toBeNull();
    expect(Number(hoverMix![1])).toBeLessThanOrEqual(60);

    const active = rule(source, ".active,\n.interactive.active:where(:not(.disabled)):hover");
    expect(active).toContain("background: var(--selection-strong)");
    expect(active).toContain("color: var(--text-primary)");
    expect(rule(source, ".active .label")).toContain(
      "font-weight: var(--font-weight-medium)",
    );
    expect(rule(source, ".active .icon")).toContain("opacity: 1");
  });
});

describe("inspector content alignment", () => {
  test("inspector content packs rows at the start instead of stretching them", () => {
    const css = read(`${uiSrc}/libs/design-system/blocks/InspectorShell/InspectorShell.module.css`);
    const start = css.search(/^\.content \{/mu);
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("}", start));
    expect(block).toContain("display: grid");
    expect(block).toContain("align-content: start");
  });
});

describe("documents, artifacts, and briefing titles", () => {
  test("link-rendered buttons are not underlined unless they are link variants", () => {
    const css = read(`${uiSrc}/libs/design-system/components/Button/Button.module.css`);
    const base = css.slice(css.indexOf(".button {"), css.indexOf("}", css.indexOf(".button {")));
    expect(base).toContain("text-decoration: none");
    const link = css.slice(css.indexOf(".variantLink {"), css.indexOf("}", css.indexOf(".variantLink {")));
    expect(link).toContain("text-decoration: underline");
  });

  test("project briefing fallback titles are short and balanced", () => {
    expect(getAppCopy("en-US").briefing.projectTitle("Butler")).toBe("Continue in Butler");
    expect(getAppCopy("ko-KR").briefing.projectTitle("Butler")).toBe("Butler에서 이어가기");
    const css = read(`${uiSrc}/libs/design-system/blocks/PromptSuggestionList/PromptSuggestionList.module.css`);
    const title = css.slice(css.search(/^\.title \{/mu), css.indexOf("}", css.search(/^\.title \{/mu)));
    expect(title).toContain("text-wrap: balance");
  });
});

describe("token inventory cleanup", () => {
  const retired = [
    "--color-action-primary-hover",
    "--color-action-primary-active",
    "--color-surface-sunken",
    "--shadow-command",
    "--font-size-display",
    "--accent-foreground",
    "--automation-details-bg",
    "--worker-title-bg",
  ];

  test("retired tokens are not defined (DS Viewer token pages come from tokens.css)", () => {
    const css = read(tokensPath);
    for (const name of retired) {
      expect(css).not.toMatch(new RegExp(`${name}:`, "u"));
    }
  });

  test("legacy surface aliases reference the semantic surface layer in every theme", () => {
    for (const tokens of [rootTokens(), themeTokens(".theme-light"), themeTokens(".theme-dark")]) {
      expect(tokens.get("--surface-raised")).toBe("var(--color-surface-raised)");
      expect(tokens.get("--popover")).toBe("var(--color-surface-overlay)");
    }
    for (const theme of [".theme-light", ".theme-dark"] as const) {
      expect(themeTokens(theme).get("--color-surface-raised")).toBeDefined();
      expect(themeTokens(theme).get("--color-surface-overlay")).toBeDefined();
    }
  });
});

describe("single type scale", () => {
  const aliases: Array<[string, string]> = [
    ["--font-size-1", "--typo-caption-size"],
    ["--font-size-2", "--typo-label-size"],
    ["--font-size-3", "--typo-body-size"],
    ["--font-size-4", "--typo-app-title-size"],
    ["--font-size-5", "--typo-h4-size"],
    ["--font-size-6", "--typo-h2-size"],
  ];

  test("legacy numeric font sizes alias the canonical --typo-* scale", () => {
    const tokens = rootTokens();
    for (const [legacy, canonical] of aliases) {
      expect(tokens.get(legacy)).toBe(`var(${canonical})`);
    }
  });

  test("compact widths resize only the canonical scale", () => {
    const css = read(tokensPath);
    const mobile = css.slice(css.indexOf("@media (width <= 640px) {"));
    const block = mobile.slice(0, mobile.indexOf("\n}\n"));
    expect(block).toContain("--typo-body-size: 16px");
    expect(block).not.toMatch(/--font-size-\d:/u);
  });
});

describe("motion tokens", () => {
  test("define the duration scale, exit durations and shared easings", () => {
    const tokens = rootTokens();
    expect(tokens.get("--motion-instant")).toBe("60ms");
    expect(tokens.get("--motion-menu")).toBe("90ms");
    expect(tokens.get("--motion-fast")).toBe("120ms");
    expect(tokens.get("--motion-base")).toBe("160ms");
    expect(tokens.get("--motion-slow")).toBe("220ms");
    expect(tokens.get("--motion-deliberate")).toBe("320ms");
    expect(tokens.get("--motion-exit-menu")).toBe("60ms");
    expect(tokens.get("--motion-exit-fast")).toBe("90ms");
    expect(tokens.get("--motion-exit-base")).toBe("110ms");
    expect(tokens.get("--motion-exit-slow")).toBe("150ms");
    expect(tokens.get("--motion-ease-standard")).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(tokens.get("--motion-ease-decelerate")).toBe("cubic-bezier(0, 0, 0, 1)");
    expect(tokens.get("--motion-ease-accelerate")).toBe("cubic-bezier(0.3, 0, 1, 1)");
    expect(tokens.get("--motion-ease-emphasized")).toBe("cubic-bezier(0.2, 0.8, 0.2, 1)");
    expect(tokens.get("--motion-ease-enter")).toBe("var(--motion-ease-standard)");
    expect(tokens.get("--motion-enter-menu")).toBe("140ms");
    expect(tokens.get("--motion-enter-overlay")).toBe("var(--motion-base)");
    expect(tokens.get("--motion-ease-exit")).toBe("var(--motion-ease-accelerate)");
    expect(tokens.get("--motion-ease-linear")).toBe("linear");
    expect(tokens.get("--adaptive-panel-duration")).toBe("var(--motion-slow)");
    expect(tokens.get("--adaptive-panel-easing")).toBe("var(--motion-ease-emphasized)");
  });

  test("the spring easing overshoots by about 3% and settles at 1", () => {
    const spring = rootTokens().get("--motion-ease-spring") ?? "";
    expect(spring.startsWith("linear(")).toBe(true);
    const points = spring.slice("linear(".length, -1).split(",").map((point) => Number(point.trim()));
    expect(points[0]).toBe(0);
    expect(points.at(-1)).toBe(1);
    const peak = Math.max(...points);
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.04);
  });

  test("distance and scale tokens collapse to a pure fade under reduced motion", () => {
    const tokens = rootTokens();
    expect(tokens.get("--motion-distance-xs")).toBe("2px");
    expect(tokens.get("--motion-distance-sm")).toBe("4px");
    expect(tokens.get("--motion-distance-md")).toBe("8px");
    expect(tokens.get("--motion-distance-lg")).toBe("24px");
    expect(tokens.get("--motion-scale-menu")).toBe("0.97");
    expect(tokens.get("--motion-scale-dialog")).toBe("0.96");
    expect(tokens.get("--motion-scale-press")).toBe("0.97");
    const css = read(tokensPath);
    const media = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    const reduced = parseTokens(tokenBlock(media, ":root"));
    for (const name of ["xs", "sm", "md", "lg"]) expect(reduced.get(`--motion-distance-${name}`)).toBe("0px");
    for (const name of ["menu", "dialog", "press"]) expect(reduced.get(`--motion-scale-${name}`)).toBe("1");
  });

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

  test("menus, selects and tooltips open on the menu enter token and the enter curve", () => {
    for (const file of ["components/DropdownMenu/DropdownMenu", "components/ContextMenu/ContextMenu", "components/Select/Select", "shadcn/ui/tooltip"]) {
      const css = read(`${uiSrc}/libs/design-system/${file}.module.css`);
      expect(css).toMatch(/animation: [\w-]+-enter var\(--motion-enter-menu\)\s+var\(--motion-ease-enter\)/u);
    }
    const popover = read(`${uiSrc}/libs/design-system/components/Popover/Popover.module.css`);
    expect(popover).toMatch(/animation: popover-enter var\(--motion-enter-overlay\)\s+var\(--motion-ease-enter\)/u);
    const toast = read(`${uiSrc}/libs/design-system/components/Toast/Toast.module.css`);
    expect(toast).toMatch(/transform var\(--motion-enter-overlay\) var\(--motion-ease-enter\)/u);
  });

  test("overlay enters land at most ~30% of the change in the first 60Hz frame; exits stay faster", () => {
    const tokens = rootTokens();
    const resolve = (value: string): string => {
      const ref = /^var\((--[\w-]+)\)$/u.exec(value);
      return ref ? resolve(tokens.get(ref[1]!) ?? "") : value;
    };
    const ms = (name: string) => Number(/^(\d+)ms$/u.exec(resolve(`var(${name})`))?.[1]);
    const curve = resolve("var(--motion-ease-enter)").match(/-?\d*\.?\d+/gu)!.map(Number);
    const sample = (a: number, b: number, u: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u ** 2 * (1 - u) + u ** 3;
    const progress = (t: number) => {
      let low = 0;
      let high = 1;
      for (let step = 0; step < 30; step += 1) {
        const mid = (low + high) / 2;
        if (sample(curve[0]!, curve[2]!, mid) < t) low = mid;
        else high = mid;
      }
      return sample(curve[1]!, curve[3]!, (low + high) / 2);
    };
    const frame = 1000 / 60;
    for (const [enter, exit] of [["--motion-enter-menu", "--motion-exit-menu"], ["--motion-enter-overlay", "--motion-exit-fast"], ["--motion-enter-overlay", "--motion-exit-base"]] as const) {
      expect(progress(frame / ms(enter))).toBeLessThanOrEqual(0.3);
      expect(ms(exit)).toBeLessThan(ms(enter));
    }
    // Menus stay faster than dialogs.
    expect(ms("--motion-enter-menu")).toBeLessThan(ms("--motion-base"));
  });

  test("menu and select animations keep a pure fade under reduced motion", () => {
    for (const file of ["DropdownMenu/DropdownMenu", "ContextMenu/ContextMenu", "Select/Select"]) {
      const css = read(`${uiSrc}/libs/design-system/components/${file}.module.css`);
      expect(css).not.toContain("animation: none");
      const keyframes = css.slice(css.indexOf("@keyframes"));
      expect(keyframes).toContain("var(--motion-scale-menu)");
      expect(keyframes).not.toMatch(/translate[XY]?\(\s*-?\d/u);
    }
  });

  const dsComponent = (file: string) => read(`${uiSrc}/libs/design-system/components/${file}.module.css`);

  test("Radix overlays exit on [data-state=closed] with faster exit tokens and accelerate", () => {
    for (const [file, exit] of [
      ["DropdownMenu/DropdownMenu", "--motion-exit-menu"],
      ["ContextMenu/ContextMenu", "--motion-exit-menu"],
      ["Popover/Popover", "--motion-exit-fast"],
      ["Dialog/Dialog", "--motion-exit-fast"],
    ] as const) {
      const css = dsComponent(file);
      expect(css).toMatch(new RegExp(`\\[data-state="closed"\\] \\{[^}]*animation: [\\w-]+-exit var\\(${exit}\\)\\s+var\\(--motion-ease-accelerate\\)`, "u"));
    }
    const dialog = dsComponent("Dialog/Dialog");
    expect(dialog).toMatch(/\.overlay\[data-state="closed"\] \{[^}]*animation: dialog-overlay-exit/u);
    expect(dialog).toContain("var(--motion-scale-dialog)");
  });

  test("popper overlays enter from their Radix transform origin with a side-aware distance", () => {
    for (const [file, origin] of [
      ["DropdownMenu/DropdownMenu", "--radix-dropdown-menu-content-transform-origin"],
      ["ContextMenu/ContextMenu", "--radix-context-menu-content-transform-origin"],
      ["Select/Select", "--radix-select-content-transform-origin"],
      ["Popover/Popover", "--radix-popover-content-transform-origin"],
    ] as const) {
      const css = dsComponent(file);
      expect(css).toMatch(new RegExp(`var\\(\\s*${origin}`, "u"));
      for (const side of ["top", "bottom", "left", "right"]) expect(css).toContain(`[data-side="${side}"]`);
      expect(css).toContain("var(--motion-distance-");
    }
  });

  test("the tooltip fades out through Presence on the exit token", () => {
    const css = read(`${uiSrc}/libs/design-system/shadcn/ui/tooltip.module.css`);
    expect(css).toMatch(/\.tooltip\[data-state="closed"\] \{[^}]*animation: tooltip-exit var\(--motion-exit-fast\)/u);
    expect(css).not.toContain("animation: none");
    const tsx = read(`${uiSrc}/libs/design-system/shadcn/ui/tooltip.tsx`);
    expect(tsx).toContain("usePresence");
  });

  test("buttons, icon buttons and clickables press to the press scale unless disabled", () => {
    const button = dsComponent("Button/Button");
    expect(button).toMatch(/\.button:active:not\(:disabled, \[aria-disabled="true"\]\) \{[^}]*scale: var\(--motion-scale-press\);[^}]*transition-duration: var\(--motion-instant\)/u);
    const iconButton = dsComponent("IconButton/IconButton");
    expect(iconButton).toMatch(/\.moduleScope:active:not\(:disabled\) \{[^}]*scale: var\(--motion-scale-press\)/u);
    expect(iconButton).toMatch(/transition:[^;]*scale var\(--motion-fast\)/u);
    const clickable = dsComponent("Clickable/Clickable");
    expect(clickable).toMatch(/\.clickable:active:not\(\[data-disabled="true"\], \[data-stretch="true"\]\) \{[^}]*scale: var\(--motion-scale-press\)/u);
  });

  test("the switch thumb moves on the spring easing and stops under reduced motion", () => {
    const css = dsComponent("Switch/Switch");
    expect(css).toMatch(/\.thumb \{[^}]*transition: transform var\(--motion-base\) var\(--motion-ease-spring\)/u);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.thumb \{\s*transition: none;/u);
  });
});

describe("Korean typography", () => {
  test("Korean text keeps words whole with an overflow-wrap safety net", () => {
    const tokens = read(`${uiSrc}/libs/design-system/tokens.css`);
    // Every lang="ko" subtree, not only the root: a Korean message in an English window wraps the same way.
    expect(tokens).toMatch(
      /\n:lang\(ko\) \{\s*word-break: keep-all;\s*overflow-wrap: break-word;\s*\}/u,
    );
  });
});

describe("icon size tokens", () => {
  test("tokens define the 12/14/16/20/24/32 icon scale", () => {
    const tokens = rootTokens();
    expect(tokens.get("--icon-size-xs")).toBe("12px");
    expect(tokens.get("--icon-size-sm")).toBe("14px");
    expect(tokens.get("--icon-size-md")).toBe("16px");
    expect(tokens.get("--icon-size-lg")).toBe("20px");
    expect(tokens.get("--icon-size-xl")).toBe("24px");
    expect(tokens.get("--icon-size-2xl")).toBe("32px");
  });

  test("DS icons use named sizes instead of literal 11-32px sizes", () => {
    const icons = read(`${uiSrc}/libs/design-system/components/Icons/Icons.tsx`);
    const names = [...icons.matchAll(/^export const (\w+) =/gmu)].map((match) => match[1]);
    const offenders = walkUiSources(uiSrc)
      .filter((path) => path.endsWith(".tsx") && !path.endsWith(".test.tsx"))
      .flatMap((path) => {
        const text = read(path);
        const props = [...text.matchAll(/<(\w+)\b([^<>]*?)\bsize=\{(1[1-8]|2[0-4]|32)\}/gsu)]
          .filter((match) => names.includes(match[1]))
          .map((match) => `${path}: <${match[1]} size={${match[3]}}>`);
        const clones = [...text.matchAll(/cloneElement\([^)]*\{\s*size:\s*(1[1-8]|2[0-4]|32)\b/gsu)]
          .map((match) => `${path}: cloneElement size ${match[1]}`);
        return [...props, ...clones];
      });
    expect(offenders).toEqual([]);
  });

  test("icon defaults and CSS icon fallbacks use the md token", () => {
    const icons = read(`${uiSrc}/libs/design-system/components/Icons/Icons.tsx`);
    expect(icons).toContain('size = "md"');
    expect(icons).not.toMatch(/size = 1[3-8]\b/u);
    for (const file of [
      "blocks/NavRow/NavRow.module.css",
      "blocks/TitlebarShell/TitlebarShell.module.css",
      "components/Clickable/Clickable.module.css",
    ]) {
      const css = read(`${uiSrc}/libs/design-system/${file}`);
      expect(css).not.toMatch(/icon-size, (min\()?1[3-8]px/u);
      expect(css).toContain("var(--icon-size-md)");
    }
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

describe("keyboard and pressed states mirror hover", () => {
  const css = (file: string) => read(`${uiSrc}/libs/design-system/${file}`);

  test("clickable rows show a pressed state", () => {
    expect(css("components/Clickable/Clickable.module.css")).toMatch(
      /\.clickable:active:not\(\[data-disabled="true"\]\) \{\s*background: var\(--selection-strong\);/u,
    );
    const sticky = css("blocks/CollapsibleNavGroup/CollapsibleNavGroup.module.css");
    expect(sticky).toContain('.stickyGroup > .header[data-slot="clickable"]:active');
  });

  test("breadcrumb links respond to keyboard focus and press", () => {
    const breadcrumb = css("components/Breadcrumb/Breadcrumb.module.css");
    expect(breadcrumb).toContain(".link:focus-visible");
    expect(breadcrumb).toContain(".link:active");
  });

  test("suggestion cards lift for keyboard focus and settle when pressed", () => {
    const list = css("blocks/PromptSuggestionList/PromptSuggestionList.module.css");
    expect(list).toContain(".itemFrame:has(.item:focus-visible)");
    expect(list).toContain(".itemFrame:has(.item:active)");
  });
});
