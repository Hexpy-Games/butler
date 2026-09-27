import { describe, expect, test } from "bun:test";
import stylelint from "stylelint";
import {
  butlerDsStylelintPlugins,
  defaultDsCustomProperties,
} from "../../packages/butler-app/scripts/lint/butler-ds/stylelint-plugin.ts";

async function warnings(rule: string, code: string, options: unknown = true): Promise<string[]> {
  const result = await stylelint.lint({
    code,
    codeFilename: "Product.module.css",
    config: { plugins: butlerDsStylelintPlugins, rules: { [`butler-ds/${rule}`]: options } },
  });
  return result.results[0].warnings.map((warning) => warning.text);
}

describe("butler-ds/token-only-values", () => {
  const valid = [
    ".a { color: var(--text); background: transparent; border: 1px solid var(--line); }",
    ".a { color: currentcolor; fill: none; outline: none; }",
    ".a { padding: 0; margin: auto; margin-inline: auto; gap: var(--space-2) var(--space-4); }",
    ".a { inset: 0; top: 50%; left: calc(100% - var(--space-2)); margin-top: calc(-1 * var(--border-hairline)); }",
    ".a { padding: calc(var(--space-2) * 2); padding-block: env(safe-area-inset-top); }",
    ".a { border-radius: 50%; border-radius: var(--radius-control); border-radius: 0; }",
    ".a { z-index: auto; z-index: var(--z-popover); z-index: 0; }",
    ".a { transition: opacity var(--motion-fast) var(--motion-ease-standard); transition: none; }",
    ".a { animation: spin var(--spinner-duration) linear infinite; }",
    ".a { font-size: inherit; line-height: var(--line-height-body); font-weight: var(--font-weight-medium); }",
    ".a { line-height: 1; font: var(--font-size-2)/var(--line-height-body) var(--font-body); }",
    ".a { width: 16px; height: 2px; --local-size: 12px; }",
  ];
  for (const code of valid) {
    test(`accepts ${code}`, async () => {
      expect(await warnings("token-only-values", code)).toEqual([]);
    });
  }

  const invalid: Array<[string, RegExp]> = [
    [".a { color: #fff; }", /color/u],
    [".a { background: rgba(0, 0, 0, 0.2); }", /color/u],
    [".a { border: 1px solid white; }", /color/u],
    [".a { box-shadow: 0 1px 2px hsl(0 0% 0% / 20%); }", /color/u],
    [".a { --local-tint: #123456; }", /color/u],
    [".a { padding: 12px; }", /spacing/u],
    [".a { gap: 2px; }", /spacing/u],
    // The 1px hairline exception is gone now that --border-hairline exists.
    [".a { margin-top: -1px; }", /spacing/u],
    [".a { padding: 1px var(--space-2); }", /spacing/u],
    [".a { top: 32px; }", /spacing/u],
    [".a { padding-block: max(8px, var(--space-2)); }", /spacing/u],
    [".a { margin-inline-end: 0.5rem; }", /spacing/u],
    [".a { border-radius: 6px; }", /radius/u],
    [".a { z-index: 30; }", /z-index/u],
    [".a { transition: opacity 120ms; }", /motion/u],
    [".a { transition: opacity var(--motion-fast) ease; }", /motion/u],
    [".a { animation-timing-function: cubic-bezier(0.2, 0, 0, 1); }", /motion/u],
    [".a { font-size: 13px; }", /typography/u],
    [".a { line-height: 1.4; }", /typography/u],
    [".a { font-weight: 600; }", /typography/u],
    [".a { font: 12px/1.2 sans-serif; }", /typography/u],
  ];
  for (const [code, reason] of invalid) {
    test(`rejects ${code}`, async () => {
      const found = await warnings("token-only-values", code);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatch(reason);
      expect(found[0]).toContain("(butler-ds/token-only-values)");
    });
  }
});

describe("butler-ds/no-raw-length-custom-prop (warning)", () => {
  for (const code of [
    ".a { --local-size: var(--space-2); }",
    ".a { --local-ratio: 1.5; --local-name: ok; }",
    ".a { --local-offset: calc(var(--space-2) * 2); }",
    ".a { width: 16px; }",
  ]) {
    test(`accepts ${code}`, async () => {
      expect(await warnings("no-raw-length-custom-prop", code)).toEqual([]);
    });
  }

  for (const code of [
    ".a { --local-size: 12px; }",
    ".a { --local-width: min(34vw, 240px); }",
    ".a { --local-gap: calc(var(--space-2) + 0.5rem); }",
  ]) {
    test(`reports ${code}`, async () => {
      const found = await warnings("no-raw-length-custom-prop", code);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("(butler-ds/no-raw-length-custom-prop)");
    });
  }

  test("is a warning rule and not part of the ratcheted rule set", async () => {
    const scope = "../../packages/butler-app/scripts/lint/butler-ds/scope.ts";
    const { DS_STYLELINT_RULES, DS_WARNING_RULES } = await import(scope);
    expect(DS_WARNING_RULES).toContain("no-raw-length-custom-prop");
    expect(DS_STYLELINT_RULES as readonly string[]).not.toContain("no-raw-length-custom-prop");
  });
});

describe("butler-ds/no-ds-internal-selector", () => {
  const valid = [
    ".a .b { color: var(--text); }",
    '.a[data-active="true"] { color: var(--text); }',
    '.pre [data-syntax="keyword"] { color: var(--text); }',
    ".a::after, .a:hover, .a:focus-visible { color: var(--text); }",
    ":global(.theme-dark) .a { color: var(--text); }",
    "@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }",
  ];
  for (const code of valid) {
    test(`accepts ${code}`, async () => {
      expect(await warnings("no-ds-internal-selector", code)).toEqual([]);
    });
  }

  const invalid = [
    ".a svg { color: var(--text); }",
    ".a > button:first-child { color: var(--text); }",
    ".header > div { color: var(--text); }",
    '.a [data-slot="icon"] { color: var(--text); }',
    '.a[data-state="open"] { color: var(--text); }',
    ".a [data-radix-popper-content-wrapper] { color: var(--text); }",
    ":global(.scroll-fade) .a { color: var(--text); }",
    ".a :global(.navRow) { color: var(--text); }",
  ];
  for (const code of invalid) {
    test(`rejects ${code}`, async () => {
      expect(await warnings("no-ds-internal-selector", code)).toHaveLength(1);
    });
  }
});

describe("butler-ds/no-ds-custom-prop-override", () => {
  const options = [true, { properties: ["--clickable-action-size", "--space-2"], prefixes: ["--sidebar-"] }];

  test("accepts product-owned custom properties and reading DS properties", async () => {
    expect(await warnings("no-ds-custom-prop-override",
      ".a { --local-size: 4px; width: var(--clickable-action-size); }", options)).toEqual([]);
  });

  for (const code of [
    ".a { --clickable-action-size: 20px; }",
    ".a { --sidebar-row-height: 30px; }",
    ".a { --space-2: 3px; }",
  ]) {
    test(`rejects ${code}`, async () => {
      const found = await warnings("no-ds-custom-prop-override", code, options);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain("(butler-ds/no-ds-custom-prop-override)");
    });
  }

  test("default DS properties are every custom property the DS CSS defines or reads", () => {
    const properties = defaultDsCustomProperties();
    for (const name of ["--space-2", "--selection-strong", "--icon-button-radius", "--clickable-action-size"]) {
      expect(properties.has(name)).toBe(true);
    }
    expect(properties.has("--space-tree-icon-size")).toBe(false);
  });

  test("the default option set rejects a DS component knob", async () => {
    expect(await warnings("no-ds-custom-prop-override", ".a { --icon-button-radius: 4px; }")).toHaveLength(1);
  });
});
