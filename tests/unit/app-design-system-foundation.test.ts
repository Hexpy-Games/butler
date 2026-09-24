import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveRepoOrLedgerPath } from "../support/project-ledger-root.ts";
import { getAppCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { lintDesignSystemRules } from "../../packages/butler-app/scripts/lint/design-system-rules-lint.ts";

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

  test("spec records the Phase 2 screen contracts", () => {
    const spec = read(
      "project-ledger/projects/butler/specs/butler-dedicated-client-design-system.md",
    );
    expect(spec).toContain("## Phase 2 Screen Contracts");
    for (const heading of [
      "### Adaptive Drawer Width",
      "### Sidebar Default State",
      "### Filtered Select Popover",
      "### Command Palette",
      "### Settings Screens",
      "### Code Blocks And Message Footer",
      "### Composer Toolbar",
      "### Navigation Rows",
      "### Inspector Content",
      "### Documents, Artifacts, And Briefing Titles",
    ]) {
      expect(spec).toContain(heading);
    }
    expect(spec).toContain("aria-activedescendant");
    expect(spec).toContain("--syntax-");
    expect(spec).toContain("Preferences");
    expect(spec).toContain("A saved user choice");
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
    const css = read(`${uiSrc}/components/conversation/MarkdownCodeBlock.module.css`);
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
    const hover = rule(source, ".interactive:hover");
    const hoverMix = /var\(--selection\)\s+(\d+)%/u.exec(hover);
    expect(hoverMix).not.toBeNull();
    expect(Number(hoverMix![1])).toBeLessThanOrEqual(60);

    const active = rule(source, ".active,\n.interactive.active:hover");
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
