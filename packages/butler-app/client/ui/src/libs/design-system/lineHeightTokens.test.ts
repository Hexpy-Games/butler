// test-category: pure-logic
/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const srcRoot = new URL("../..", import.meta.url).pathname;
const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const rootBlock = /:root\s*\{([^}]*)\}/u.exec(tokens)?.[1] ?? "";
const declared = new Map(
  [...rootBlock.matchAll(/(--line-height-[\w-]+)\s*:\s*([^;]+);/gu)].map((match) => [match[1]!, match[2]!.trim()]),
);

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

function resolve(name: string, depth = 0): number {
  const value = declared.get(name);
  if (value === undefined || depth > 4) throw new Error(`${name} is not a line-height token`);
  const alias = /^var\((--line-height-[\w-]+)\)$/u.exec(value);
  return alias ? resolve(alias[1]!, depth + 1) : Number(value);
}

test("every referenced line-height token is declared", () => {
  const referenced = new Set(
    cssFiles(srcRoot).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/var\((--line-height-[\w-]+)\)/gu)].map((match) => match[1]!),
    ),
  );
  expect(referenced.has("--line-height-compact")).toBe(true);
  for (const name of referenced) expect(declared.has(name), name).toBe(true);
});

test("--line-height-compact is the snug step of the ramp for compact UI labels", () => {
  expect(declared.get("--line-height-compact")).toBe("var(--line-height-snug)");
  const ramp = ["none", "tight", "snug", "body", "document"].map((step) => resolve(`--line-height-${step}`));
  expect([...ramp].sort((a, b) => a - b)).toEqual(ramp);
  expect(resolve("--line-height-compact")).toBeGreaterThan(resolve("--line-height-tight"));
  expect(resolve("--line-height-compact")).toBeLessThan(resolve("--line-height-body"));
});
