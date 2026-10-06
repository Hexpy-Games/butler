/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ChevronDown, ChevronDownIcon, ICON_SIZE, Plus } from "./Icons";

const source = readFileSync(join(import.meta.dir, "Icons.tsx"), "utf8");

test("icons import Hugeicons by name so unused icons tree-shake", () => {
  expect(source).not.toMatch(/import \* as \w+ from "@hugeicons\/core-free-icons"/u);
  expect(source).toMatch(/import \{[^}]+\} from "@hugeicons\/core-free-icons"/u);
});

test("each Hugeicons glyph is mapped once; alternate names alias it", () => {
  const mapped = [...source.matchAll(/createIcon\((\w+)\)/gu)].map((match) => match[1]);
  expect(mapped.length).toBeGreaterThan(40);
  expect(new Set(mapped).size).toBe(mapped.length);
  expect(ChevronDownIcon).toBe(ChevronDown);
});

// test-category: format-pin
test("named icon sizes render the token scale", () => {
  expect(ICON_SIZE).toEqual({ xs: 12, sm: 14, md: 16, lg: 20, xl: 24, "2xl": 32, "3xl": 48 });
  expect(renderToStaticMarkup(<Plus size="xs" />)).toContain('width="12"');
  expect(renderToStaticMarkup(<Plus size="xl" />)).toContain('width="24"');
  expect(renderToStaticMarkup(<Plus size="2xl" />)).toContain('width="32"');
  expect(renderToStaticMarkup(<Plus size="sm" />)).toContain('width="14"');
  expect(renderToStaticMarkup(<Plus size="md" />)).toContain('width="16"');
  expect(renderToStaticMarkup(<Plus size="lg" />)).toContain('width="20"');
  expect(renderToStaticMarkup(<Plus size={48} />)).toContain('width="48"');
});

test("icons default to the md size", () => {
  expect(renderToStaticMarkup(<Plus />)).toContain('width="16"');
});
