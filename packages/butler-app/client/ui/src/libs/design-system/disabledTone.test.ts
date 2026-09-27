/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tokens = read("./tokens.css");

/** Rules whose selector matches `pattern`, as "selector { body }" strings. */
function rules(css: string, pattern: RegExp): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(([, selector]) => pattern.test(selector!))
    .map(([, selector, body]) => `${selector!.trim()} {${body}}`);
}

test("the disabled tone is a token pair defined once for both themes", () => {
  expect(tokens).toMatch(/--interactive-disabled-fg:\s*var\(--color-text-disabled\)/u);
  expect(tokens).toMatch(/--interactive-disabled-cursor:\s*not-allowed/u);
});

for (const [name, path, disabled] of [
  ["Select item", "./components/Select/Select.module.css", /\.item\[data-disabled\]/u],
  ["DropdownMenu item", "./components/DropdownMenu/DropdownMenu.module.css", /\.item\[data-disabled\]/u],
  ["ContextMenu item", "./components/ContextMenu/ContextMenu.module.css", /\.item\[data-disabled\]/u],
  ["Clickable", "./components/Clickable/Clickable.module.css", /\.clickable\[data-disabled="true"\]/u],
  ["NavRow", "./blocks/NavRow/NavRow.module.css", /\.disabled\b/u],
  ["OptionMenu item", "./blocks/OptionMenu/OptionMenu.module.css", /\.item\[data-disabled="true"\]/u],
  // A disabled field (the masked hosted API key) must not look editable.
  ["Input", "./components/Input/Input.module.css", /\.input:disabled/u],
  ["Textarea", "./components/Textarea/Textarea.module.css", /\.textarea:disabled/u],
] as const) {
  test(`${name} renders disabled with the disabled tone and no hover fill`, () => {
    const css = read(path);
    const disabledRules = rules(css, disabled).join("\n");
    expect(disabledRules).toMatch(/color:\s*var\(--interactive-disabled-fg\)/u);
    expect(disabledRules).toMatch(/cursor:\s*var\(--interactive-disabled-cursor\)/u);
    // Opacity dimming made disabled rows look like faded enabled rows.
    expect(disabledRules).not.toMatch(/opacity:\s*0\.5/u);
    // Hover and keyboard highlight never fill a disabled item.
    for (const hover of rules(css, /:hover|:focus(?!-visible)|\[data-highlighted\]/u)) {
      const selector = hover.slice(0, hover.indexOf("{"));
      if (/background/u.test(hover) && !/disabled/u.test(selector)) {
        expect(selector, `${name}: ${selector}`).toMatch(/:not\([^)]*disabled/u);
      }
    }
  });
}
