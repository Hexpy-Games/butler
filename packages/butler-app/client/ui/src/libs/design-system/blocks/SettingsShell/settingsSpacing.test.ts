/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = read("../../tokens.css");
const formSection = read("../FormSection/FormSection.module.css");
const settingsShell = read("./SettingsShell.module.css");
const settingsField = read("../SettingsField/SettingsField.module.css");
const settingsFieldComponent = read("../SettingsField/SettingsField.tsx");
const formSectionComponent = read("../FormSection/FormSection.tsx");
const settingsHeaderComponent = read("../SettingsHeader/SettingsHeader.tsx");

/** Token declarations of the first `:root` block, or of `:root` inside the given media query. */
function rootTokens(media?: string): Map<string, string> {
  let css = tokens;
  if (media) {
    const start = tokens.indexOf(`@media ${media}`);
    if (start < 0) return new Map();
    css = tokens.slice(start);
  }
  const block = /:root\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";
  return new Map([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)].map((match) => [match[1], match[2].trim()]));
}

function px(name: string, media?: string): number {
  const base = rootTokens();
  const scoped = media ? rootTokens(media) : new Map<string, string>();
  const resolve = (token: string, depth = 0): number => {
    const value = scoped.get(token) ?? base.get(token);
    if (!value || depth > 8) throw new Error(`unresolved ${token}`);
    const reference = /^var\((--[\w-]+)\)$/u.exec(value);
    if (reference) return resolve(reference[1], depth + 1);
    const length = /^(\d+(?:\.\d+)?)px$/u.exec(value);
    if (!length) throw new Error(`${token} is not a px length: ${value}`);
    return Number(length[1]);
  };
  return resolve(name);
}

const COMPACT = "(width <= 760px)";

test("settings sections sit clearly further apart than the fields inside them", () => {
  expect(px("--settings-field-gap")).toBe(20);
  expect(px("--settings-section-gap")).toBe(32);
  for (const media of [undefined, COMPACT]) {
    expect(px("--settings-section-gap", media)).toBeGreaterThanOrEqual(32);
    expect(px("--settings-section-gap", media)).toBeGreaterThanOrEqual(1.5 * px("--settings-field-gap", media));
  }
});

test("the settings spacing ramp tightens from section to field to copy", () => {
  expect(px("--settings-field-copy-gap")).toBe(6);
  expect(px("--settings-field-control-gap")).toBe(12);
  expect(px("--settings-section-header-gap")).toBe(16);
  for (const media of [undefined, COMPACT]) {
    const ramp = [
      "--settings-field-copy-gap",
      "--settings-field-control-gap",
      "--settings-section-header-gap",
      "--settings-field-gap",
      "--settings-section-gap",
    ].map((token) => px(token, media));
    for (let index = 1; index < ramp.length; index += 1) {
      expect(ramp[index]!).toBeGreaterThan(ramp[index - 1]!);
    }
    // A section card never insets its content less than the gap between its fields.
    expect(px("--settings-section-padding", media)).toBeGreaterThanOrEqual(px("--settings-field-gap", media) - 4);
  }
  expect(px("--settings-section-padding")).toBe(24);
});

test("settings blocks consume the ramp and the type hierarchy", () => {
  expect(settingsField).toMatch(/\.field\s*\{[^}]*gap:\s*var\(--settings-field-control-gap\)/u);
  expect(settingsField).toMatch(/\.copy\s*\{[^}]*gap:\s*var\(--settings-field-copy-gap\)/u);
  expect(settingsField).toMatch(/\.control\s*\{[^}]*gap:\s*var\(--settings-field-control-gap\)/u);
  expect(settingsField).toMatch(/\.description\s*\{[^}]*color:\s*var\(--text-secondary\)/u);
  expect(formSection).toMatch(/\.section\s*\{[^}]*padding:\s*var\(--settings-section-padding\)/u);
  expect(formSection).toMatch(/\.section\s*\{[^}]*gap:\s*var\(--settings-section-header-gap\)/u);
  expect(formSectionComponent).toContain('<Typo.H4 as="h3"');
  expect(formSectionComponent).toContain("<Typo.Body className={styles.description}");
  expect(formSection).toMatch(/\.description\s*\{[^}]*color:\s*var\(--text-secondary\)/u);
  expect(settingsHeaderComponent).toContain('<Typo.H2 as="h2"');
  expect(settingsFieldComponent).toContain("<Typo.Caption");
});

test("FormSection fields and SettingsShell sections consume the settings gap tokens", () => {
  expect(formSection).toMatch(/\.fields\s*\{[^}]*gap:\s*var\(--settings-field-gap\)/u);
  const detailContentRules = [...settingsShell.matchAll(/\.detailContent\s*\{([^}]*)\}/gu)].map((match) => match[1]);
  expect(detailContentRules[0]).toMatch(/gap:\s*var\(--settings-section-gap\)/u);
  for (const rule of detailContentRules) expect(rule).not.toMatch(/gap:\s*var\(--space-/u);
});

test("a section header reads as its own block above the fields (title > field label > descriptions)", () => {
  // Header block: hairline divider under title + description, then the header gap.
  expect(formSection).toMatch(/\.header\s*\{[^}]*padding-bottom:\s*var\(--space-lg\)/u);
  expect(formSection).toMatch(/\.header\s*\{[^}]*border-bottom:\s*var\(--border-hairline\) solid var\(--line\)/u);
  // Section description: secondary, one step below the body-size field label, limited measure.
  const description = /\.description\s*\{([^}]*)\}/u.exec(formSection)?.[1] ?? "";
  expect(description).toMatch(/font-size:\s*var\(--font-size-2\)/u);
  expect(description).toMatch(/max-width:\s*60ch/u);
  expect(description).toMatch(/color:\s*var\(--text-secondary\)/u);
  // Ramp by size: H4 title 18 > field Label 14 (medium) > section description 13 > field description 12.
  const size = (token: string) => Number(/(\d+)px/u.exec(rootTokens().get(token) ?? "")?.[1]);
  expect(size("--typo-h4-size")).toBeGreaterThan(size("--typo-body-size"));
  expect(size("--typo-body-size")).toBeGreaterThan(size("--typo-label-size"));
  expect(size("--typo-label-size")).toBeGreaterThan(size("--typo-caption-size"));
});
