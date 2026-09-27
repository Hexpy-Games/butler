/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");

/** Custom properties declared by rules whose selector list includes `scope`. */
function declared(scope: string): Set<string> {
  const names = new Set<string>();
  for (const [, selectors, body] of tokens.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (!selectors!.split(",").some((selector) => selector.trim() === scope)) continue;
    for (const [, name] of body!.matchAll(/(--[\w-]+)\s*:/gu)) names.add(name!);
  }
  return names;
}

// A light panel nested in a dark chrome (DS Viewer side-by-side, portals) sees
// light values only for the tokens .theme-light re-declares, and vice versa.
test("every token the dark theme overrides is re-declared by the light theme", () => {
  const light = declared(".theme-light");
  expect([...declared(".theme-dark")].filter((name) => !light.has(name))).toEqual([]);
});

test("every token the light theme overrides is re-declared by the dark theme", () => {
  const dark = declared(".theme-dark");
  expect([...declared(".theme-light")].filter((name) => !dark.has(name))).toEqual([]);
});
