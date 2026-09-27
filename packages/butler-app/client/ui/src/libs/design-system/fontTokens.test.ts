/// <reference types="bun" />

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// Typeface Contract (DS spec): Pretendard Variable for UI text, IBM Plex Mono
// for code, both bundled and served same-origin.
const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const fonts = readFileSync(new URL("./fonts/fonts.css", import.meta.url), "utf8");
const uiPackage = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
  dependencies: Record<string, string>;
};
const rootBlock = /:root\s*\{([^}]*)\}/u.exec(tokens)?.[1] ?? "";

function stack(name: string): string[] {
  const value = new RegExp(`${name}:([^;]+);`, "u").exec(rootBlock)?.[1] ?? "";
  return value.split(",").map((family) => family.trim()).filter(Boolean);
}

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css)?.[1] ?? "";
}

test("--font-body leads with Pretendard Variable and keeps platform Hangul faces", () => {
  expect(stack("--font-body")).toEqual([
    '"Pretendard Variable"', "Pretendard", "-apple-system", "BlinkMacSystemFont", "system-ui",
    '"Apple SD Gothic Neo"', '"Malgun Gothic"', '"Noto Sans KR"', '"Noto Sans CJK KR"',
    '"Segoe UI"', "Roboto", "sans-serif",
    '"Apple Color Emoji"', '"Segoe UI Emoji"', '"Noto Color Emoji"',
  ]);
});

test("--font-family-code is IBM Plex Mono, platform monos, then Pretendard for Hangul", () => {
  const code = stack("--font-family-code");
  expect(code[0]).toBe('"IBM Plex Mono"');
  expect(code.at(-1)).toBe("monospace");
  const pretendard = code.indexOf('"Pretendard Variable"');
  expect(pretendard).toBeGreaterThan(code.indexOf("Menlo"));
  expect(pretendard).toBeLessThan(code.indexOf("monospace"));
});

test("tokens.css loads the bundled faces through fonts.css", () => {
  expect(tokens).toMatch(/@import url\("\.\/fonts\/fonts\.css"\);/u);
});

test("Pretendard ships only the official pinned dynamic-subset build", () => {
  expect(uiPackage.dependencies.pretendard).toBe("1.3.9");
  expect(fonts).toContain('@import url("pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css");');
});

test("IBM Plex Mono faces point at vendored official files with the license", () => {
  const faces = [...fonts.matchAll(/@font-face\s*\{([^}]*)\}/gu)].map((match) => match[1]!);
  expect(faces.length).toBeGreaterThan(0);
  for (const face of faces) {
    expect(face).toContain('font-family: "IBM Plex Mono"');
    expect(face).toContain("font-display: swap");
    expect(face).toContain("unicode-range:");
    const url = /url\("([^"]+)"\)/u.exec(face)?.[1] ?? "";
    expect(url).toMatch(/^\.\/ibm-plex-mono\/IBMPlexMono-(Regular|SemiBold)-\w+\.woff2$/u);
    expect(existsSync(new URL(`./fonts/${url.slice(2)}`, import.meta.url)), url).toBe(true);
  }
  const weights = new Set(faces.map((face) => /font-weight:\s*(\d+)/u.exec(face)?.[1]));
  expect([...weights].sort()).toEqual(["400", "600"]);
  expect(readFileSync(new URL("./fonts/ibm-plex-mono/LICENSE.txt", import.meta.url), "utf8"))
    .toContain("SIL OPEN FONT LICENSE Version 1.1");
});

test("tabular numerals stay opt-in, never on the document", () => {
  expect(rule(tokens, "body")).not.toContain("font-variant-numeric");
  expect(rootBlock).not.toContain("font-variant-numeric");
});

test("no letter-spacing token tightens Pretendard's built-in tracking", () => {
  const spacing = [...rootBlock.matchAll(/(--[\w-]*letter-spacing):\s*([^;]+);/gu)];
  expect(spacing.length).toBeGreaterThan(0);
  for (const [, name, value] of spacing) expect(value!.trim(), name).not.toMatch(/^-/u);
});
