// test-category: pure-logic
/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RISO_INKS } from "./components/ButlerThinkingMark/butlerMarkTheme";

// WCAG 2.x AA: body text needs 4.5:1 against what it sits on; non-text UI
// boundaries (focus ring, interactive borders) need 3:1. Every text role is
// resolved per theme the way the cascade computes it and composited over the
// surfaces it is drawn on.

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");

/** Top-level rules only (skips @media / @supports bodies), selector -> declarations. */
function topLevelRules(source: string): Array<[string, Map<string, string>]> {
  const rules: Array<[string, Map<string, string>]> = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      if (depth === 0) {
        // At-statements (@import ...;) before a rule are not part of its selector.
        selector = source.slice(start, index).split(";").at(-1)!.trim();
        start = index + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const body = source.slice(start, index);
        if (!selector.startsWith("@")) {
          const declarations = new Map<string, string>();
          for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
            declarations.set(name!, value!.replace(/\s+/gu, " ").trim());
          }
          rules.push([selector.replace(/\s+/gu, " "), declarations]);
        }
        start = index + 1;
      }
    }
  }
  return rules;
}

const rules = topLevelRules(css);
const block = (selector: string) => {
  const found = rules.find(([name]) => name === selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found[1];
};
const root = block(":root");

type Theme = "light" | "dark";
const scopes = (theme: Theme) => [block(`.theme-${theme}`), block(".theme-dark, .theme-light")];

/**
 * A custom property computes where it is declared: a theme scope declaration
 * resolves its var() references in that theme; a :root-only one resolves
 * against :root and inherits frozen into the theme.
 */
function resolve(name: string, theme: Theme | "root", depth = 0): string {
  if (depth > 20) throw new Error(`cycle resolving ${name}`);
  const scoped = theme === "root" ? undefined : scopes(theme).find((scope) => scope.has(name));
  const value = scoped?.get(name) ?? root.get(name);
  if (value === undefined) throw new Error(`undeclared ${name}`);
  const context = scoped ? theme : "root";
  return value.replace(/var\((--[\w-]+)\)/gu, (_, reference: string) => resolve(reference, context, depth + 1));
}

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/iu.exec(value);
  if (hex) return [0, 2, 4].map((offset) => Number.parseInt(hex[1]!.slice(offset, offset + 2), 16)).concat(1) as Rgba;
  const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/u.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`unsupported color ${value}`);
}

/** Paints `layers` bottom to top; the first layer must be opaque. */
function paint(layers: readonly string[], theme: Theme): Rgba {
  let [r, g, b] = parseColor(resolve(layers[0]!, theme));
  for (const layer of layers.slice(1)) {
    const [lr, lg, lb, alpha] = parseColor(resolve(layer, theme));
    [r, g, b] = [lr * alpha + r * (1 - alpha), lg * alpha + g * (1 - alpha), lb * alpha + b * (1 - alpha)];
  }
  return [r, g, b, 1];
}

function luminance([r, g, b]: Rgba): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(foreground: string, surface: readonly string[], theme: Theme): number {
  const background = paint(surface, theme);
  const [fr, fg, fb, alpha] = parseColor(resolve(foreground, theme));
  const text: Rgba = [
    fr * alpha + background[0] * (1 - alpha),
    fg * alpha + background[1] * (1 - alpha),
    fb * alpha + background[2] * (1 - alpha),
    1,
  ];
  const [high, low] = [luminance(text), luminance(background)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
}

/** Neutral surfaces text is drawn on, as token layers over the opaque base. */
const neutralSurfaces: Record<string, readonly string[]> = {
  base: ["--color-surface-base"],
  card: ["--color-surface-base", "--surface-raised"],
  overlay: ["--color-surface-base", "--color-surface-overlay"],
  panel: ["--adaptive-panel-bg"],
  settings: ["--color-surface-base", "--settings-panel-bg"],
  composer: ["--color-surface-base", "--composer-glass-bg"],
};

/** Text roles that must read on every neutral surface. */
const neutralTextRoles = [
  "--text-primary",
  "--text-secondary",
  "--text-tertiary",
  "--placeholder",
  "--menu-group-label-color",
  "--muted-foreground",
  "--accent-text",
  "--access-ask",
  "--color-success-text",
  "--color-warning-text",
  "--color-danger-text",
  "--color-info-text",
];

/** Tinted status surfaces (Tag, Notice) and the text drawn on them. */
const tintedPairs: Array<[text: string, surface: readonly string[]]> = [
  ["--color-success-text", ["--color-surface-base", "--surface-raised", "--color-success-bg"]],
  ["--color-warning-text", ["--color-surface-base", "--surface-raised", "--color-warning-bg"]],
  ["--color-danger-text", ["--color-surface-base", "--surface-raised", "--color-danger-bg"]],
  ["--color-info-text", ["--color-surface-base", "--surface-raised", "--color-info-bg"]],
  ["--send-fg", ["--send-bg"]],
  ["--primary-foreground", ["--primary"]],
];

/** Non-text UI boundaries: 3:1 on every neutral surface. */
const boundaryRoles = ["--focus-ring-color", "--color-border-interactive", "--accent"];

const themes: Theme[] = ["light", "dark"];

describe("text contrast meets WCAG AA (4.5:1) in both themes", () => {
  for (const theme of themes) {
    for (const role of neutralTextRoles) {
      test(`${theme} ${role} on neutral surfaces`, () => {
        const failures = Object.entries(neutralSurfaces)
          .map(([surface, layers]) => ({ surface, ratio: Number(contrast(role, layers, theme).toFixed(2)) }))
          .filter(({ ratio }) => ratio < 4.5);
        expect(failures).toEqual([]);
      });
    }
    // Fields (Input, Select trigger) also sit on muted fills (Box tone="muted").
    test(`${theme} --placeholder on a muted fill`, () => {
      expect(contrast("--placeholder", ["--color-surface-base", "--surface-raised", "--muted"], theme)).toBeGreaterThanOrEqual(4.5);
    });
    for (const [role, layers] of tintedPairs) {
      test(`${theme} ${role} on ${layers.at(-1)}`, () => {
        expect(contrast(role, layers, theme)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("non-text boundaries meet 3:1 in both themes", () => {
  for (const theme of themes) {
    for (const role of boundaryRoles) {
      test(`${theme} ${role} on neutral surfaces`, () => {
        const failures = Object.entries(neutralSurfaces)
          .map(([surface, layers]) => ({ surface, ratio: Number(contrast(role, layers, theme).toFixed(2)) }))
          .filter(({ ratio }) => ratio < 3);
        expect(failures).toEqual([]);
      });
    }
  }
});

// The Butler inks draw "Butler is acting" lines (riso edge, title-bar toggle,
// pointer trail) on the workspace: non-text 3:1, and the exact mark inks.
describe("Butler inks", () => {
  const inks = ["--butler-ink-blue", "--butler-ink-purple", "--butler-ink-pink"] as const;
  for (const theme of themes) {
    test(`${theme} inks reach 3:1 on the workspace`, () => {
      const failures = inks
        .map((ink) => ({ ink, ratio: Number(contrast(ink, ["--color-surface-base", "--workspace-bg"], theme).toFixed(2)) }))
        .filter(({ ratio }) => ratio < 3);
      expect(failures).toEqual([]);
    });
    test(`${theme} inks are the thinking mark's riso inks`, () => {
      const hex = (ink: string) => `#${parseColor(resolve(ink, theme)).slice(0, 3).map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
      const { blue, purple, pink } = RISO_INKS[theme];
      expect(inks.map(hex)).toEqual([blue.color, purple.color, pink.color].map((color) => color.toLowerCase()));
    });
  }
});

// Rules that color only an aria-hidden icon with the accent fill (3:1 non-text).
const accentIconRules = new Set([
  "libs/design-system/blocks/MessageAvatarBlock/MessageAvatarBlock.module.css .active",
  "libs/design-system/blocks/TodoProgressPanel/TodoProgressPanel.module.css .item[data-state=\"running\"] .marker, .item[data-state=\"reviewing\"] .marker",
]);

// Every surface: DS components and blocks, the DS Viewer and app code.
test("accent used as text reads through --accent-text, never the fill token", async () => {
  const { Glob } = await import("bun");
  const offenders: string[] = [];
  for await (const path of new Glob("**/*.module.css").scan({ cwd: new URL("../..", import.meta.url).pathname })) {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
    for (const [, selector, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      if (!/(?<![\w-])color:\s*var\(--(?:accent|color-action-primary)\)/u.test(body!)) continue;
      const rule = `${path} ${selector!.trim().replace(/\s+/gu, " ")}`;
      if (!accentIconRules.has(rule)) offenders.push(rule);
    }
  }
  expect(offenders).toEqual([]);
});
