/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = read("../../tokens.css");
const formSection = read("../FormSection/FormSection.module.css");
const settingsShell = read("./SettingsShell.module.css");

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

test("settings sections sit clearly further apart than the fields inside them", () => {
  expect(px("--settings-field-gap")).toBe(16);
  expect(px("--settings-section-gap")).toBe(32);
  expect(px("--settings-section-gap")).toBeGreaterThanOrEqual(1.5 * px("--settings-field-gap"));
  for (const media of ["(width <= 760px)"]) {
    expect(px("--settings-section-gap", media)).toBeGreaterThanOrEqual(1.5 * px("--settings-field-gap", media));
  }
});

test("FormSection fields and SettingsShell sections consume the settings gap tokens", () => {
  expect(formSection).toMatch(/\.fields\s*\{[^}]*gap:\s*var\(--settings-field-gap\)/u);
  const detailContentRules = [...settingsShell.matchAll(/\.detailContent\s*\{([^}]*)\}/gu)].map((match) => match[1]);
  expect(detailContentRules[0]).toMatch(/gap:\s*var\(--settings-section-gap\)/u);
  for (const rule of detailContentRules) expect(rule).not.toMatch(/gap:\s*var\(--space-/u);
});
