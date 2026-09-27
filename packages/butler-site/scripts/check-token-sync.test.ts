import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  APP_TOKENS_PATH,
  FORK_SCOPE_MAP,
  FORK_TOKENS_PATH,
  compareTokenScopes,
  normalizeValue,
  parseTokenScopes,
} from "./check-token-sync";

const THEME_MAP = {
  ":root": ":root",
  ':root[data-theme="dark"]': ".theme-dark",
  "@media (prefers-color-scheme: dark) :root:not([data-theme=\"light\"])": ".theme-dark",
};

describe("parseTokenScopes", () => {
  test("collects custom properties per selector and ignores other declarations", () => {
    const scopes = parseTokenScopes(`
      :root {
        color-scheme: light;
        --space-sm: 8px;
        /* a comment with --fake: 1px; inside */
        --blue-06: #007aff;
      }
    `);
    expect([...scopes.keys()]).toEqual([":root"]);
    expect(Object.fromEntries(scopes.get(":root") ?? [])).toEqual({
      "--space-sm": "8px",
      "--blue-06": "#007aff",
    });
  });

  test("keeps multi-line values and normalizes their whitespace", () => {
    const scopes = parseTokenScopes(`:root {
      --ease: linear(
        0,
        0.5,
        1
      );
      --shadow: 0 1px 3px rgba(0, 0, 0, 0.22);
    }`);
    expect(scopes.get(":root")?.get("--ease")).toBe("linear(0, 0.5, 1)");
    expect(scopes.get(":root")?.get("--shadow")).toBe("0 1px 3px rgba(0, 0, 0, 0.22)");
  });

  test("expands selector lists into separate scopes", () => {
    const scopes = parseTokenScopes(".theme-dark,\n.theme-light { --accent: var(--blue-06); }");
    expect(scopes.get(".theme-dark")?.get("--accent")).toBe("var(--blue-06)");
    expect(scopes.get(".theme-light")?.get("--accent")).toBe("var(--blue-06)");
  });

  test("prefixes scopes nested in @media and normalizes quotes", () => {
    const scopes = parseTokenScopes(`
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme='light']) { --text: var(--grayscale-02); }
      }
      @media   (width <= 640px) { :root { --typo-body-size: 16px; } }
    `);
    expect(scopes.get('@media (prefers-color-scheme: dark) :root:not([data-theme="light"])')?.get("--text"))
      .toBe("var(--grayscale-02)");
    expect(scopes.get("@media (width <= 640px) :root")?.get("--typo-body-size")).toBe("16px");
  });

  test("ignores @import, @property and @keyframes", () => {
    const scopes = parseTokenScopes(`
      @import url("./scroll-fade.css");
      @property --scroll-fade-start { syntax: "<length>"; inherits: false; initial-value: 0; }
      @keyframes pulse { to { opacity: 0.4; } }
      :root { --a: 1px; }
    `);
    expect([...scopes.keys()]).toEqual([":root"]);
  });

  test("a later declaration in the same scope wins", () => {
    const scopes = parseTokenScopes(".theme-dark { --a: 1px; } .theme-dark, .theme-light { --a: 2px; }");
    expect(scopes.get(".theme-dark")?.get("--a")).toBe("2px");
  });
});

describe("normalizeValue", () => {
  test("collapses whitespace around parentheses and commas", () => {
    expect(normalizeValue("  rgba( 0,0,  0 , 0.1 )  ")).toBe("rgba(0, 0, 0, 0.1)");
  });
});

describe("compareTokenScopes", () => {
  const app = parseTokenScopes(`
    :root { --space-sm: 8px; --blue-06: #007aff; --text: #222; --only-app: 1px; }
    .theme-dark { --text: #eee; }
  `);

  test("passes when shared tokens match and reports app-only tokens as info", () => {
    const fork = parseTokenScopes(`
      :root { --space-sm: 8px; --blue-06: #007aff; --text: #222; --web-header-height: 48px; }
      :root[data-theme="dark"] { --text: #eee; }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --text: #eee; } }
    `);
    const report = compareTokenScopes(app, fork, THEME_MAP);
    expect(report.errors).toEqual([]);
    expect(report.info.join("\n")).toContain("--only-app");
  });

  test("fails on value drift in any mapped scope", () => {
    const fork = parseTokenScopes(`
      :root { --space-sm: 9px; }
      :root[data-theme="dark"] { --text: #eee; }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --text: #ddd; } }
    `);
    const errors = compareTokenScopes(app, fork, THEME_MAP).errors.join("\n");
    expect(errors).toContain("--space-sm");
    expect(errors).toContain("--text");
    expect(errors).toContain("prefers-color-scheme");
  });

  test("fails on unprefixed tokens the app does not define", () => {
    const fork = parseTokenScopes(`
      :root { --site-gutter: 16px; }
      :root[data-theme="dark"] { --text: #eee; }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --text: #eee; } }
    `);
    expect(compareTokenScopes(app, fork, THEME_MAP).errors.join("\n")).toContain("--site-gutter");
  });

  test("allows only --web-* tokens in unmapped fork scopes", () => {
    const fork = parseTokenScopes(`
      :root { --space-sm: 8px; }
      :root[data-theme="dark"] { --text: #eee; }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --text: #eee; } }
      @media (width <= 1100px) { :root { --web-toc-width: 0px; --space-sm: 6px; } }
    `);
    const errors = compareTokenScopes(app, fork, THEME_MAP).errors.join("\n");
    expect(errors).toContain("--space-sm");
    expect(errors).not.toContain("--web-toc-width");
  });

  test("fails when a mapped scope is missing on either side", () => {
    const fork = parseTokenScopes(":root { --space-sm: 8px; }");
    const errors = compareTokenScopes(app, fork, { ...THEME_MAP, ":root[data-theme=\"light\"]": ".theme-light" }).errors
      .join("\n");
    expect(errors).toContain(':root[data-theme="dark"]');
    expect(errors).toContain(".theme-light");
  });

  test("fails on var() references the fork never defines", () => {
    const fork = parseTokenScopes(`
      :root { --space-sm: 8px; --web-gap: var(--space-lg); }
      :root[data-theme="dark"] { --text: #eee; }
      @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --text: #eee; } }
    `);
    expect(compareTokenScopes(app, fork, THEME_MAP).errors.join("\n")).toContain("--space-lg");
  });
});

describe("repository tokens", () => {
  test("the web fork is in sync with the app design system", () => {
    const app = parseTokenScopes(readFileSync(APP_TOKENS_PATH, "utf8"));
    const fork = parseTokenScopes(readFileSync(FORK_TOKENS_PATH, "utf8"));
    expect(compareTokenScopes(app, fork, FORK_SCOPE_MAP).errors).toEqual([]);
  });
});
