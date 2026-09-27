/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./PromptSuggestionList.module.css", import.meta.url), "utf8");
const root = /\.root\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";

test("the hanging title icon never touches the title, even without shell overrides", () => {
  // Default gap is a spacing token, not 0px.
  expect(root).toMatch(/--prompt-title-icon-gap:\s*var\(--new-chat-title-icon-gap,\s*var\(--space-md\)\)/u);
  // The edge gutter reserves the icon plus its gap, so the icon never leaves the frame.
  expect(root).toMatch(/--new-chat-title-edge-gutter,\s*calc\(var\(--prompt-title-icon-size\) \+ var\(--prompt-title-icon-gap\)\)/u);
});
