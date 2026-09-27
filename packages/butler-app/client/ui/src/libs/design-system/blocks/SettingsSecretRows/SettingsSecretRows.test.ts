/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./SettingsSecretRows.module.css", import.meta.url), "utf8").replace(/\s+/gu, " ");

// The four-column row needs ~450px. A narrow panel in a wide window (inspector,
// DS Viewer frame) must stack it too, so the switch keys to the block's width.
test("rows stack by the block's own width, not the viewport's", () => {
  expect(css).toMatch(/\.root \{[^}]*container: settings-secret-rows \/ inline-size;/u);
  expect(css).toMatch(/@container settings-secret-rows \(width <= 30rem\) \{[^@]*\.row \{/u);
  expect(css).not.toMatch(/@media/u);
});
