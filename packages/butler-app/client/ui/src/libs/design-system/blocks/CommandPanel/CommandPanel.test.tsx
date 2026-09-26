/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\s+/gu, " ");
const dialogCss = read("../../components/Dialog/Dialog.module.css");
const tokens = read("../../tokens.css");
const panel = read("./CommandPanel.tsx");
const dialog = read("../../shadcn/ui/dialog.tsx");

test("the palette opens with a 0.98 -> 1 scale and backdrop fade over 140ms and leaves faster", () => {
  expect(tokens).toContain("--motion-palette: 140ms;");
  expect(tokens).toContain("--motion-scale-palette: 0.98;");
  expect(tokens).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ :root \{[^}]*--motion-scale-palette: 1;/u);
  expect(dialogCss).toMatch(/\.content\[data-motion="palette"\]\[data-state="open"\] \{ animation: palette-enter var\(--motion-palette\) var\(--motion-ease-standard\);/u);
  expect(dialogCss).toMatch(/\.content\[data-motion="palette"\]\[data-state="closed"\] \{ animation: palette-exit var\(--motion-exit-fast\) var\(--motion-ease-accelerate\) forwards;/u);
  expect(dialogCss).toMatch(/\.overlay\[data-motion="palette"\]\[data-state="open"\] \{ animation: dialog-overlay-enter var\(--motion-palette\)/u);
  expect(dialogCss).toMatch(/@keyframes palette-enter \{ from \{ opacity: 0; transform: translate\(-50%, -50%\) scale\(var\(--motion-scale-palette\)\);/u);
});

test("DialogContent carries the motion to its overlay; the palette stays mounted while it closes", () => {
  expect(dialog).toMatch(/<DialogOverlay data-motion=\{motion\} \/>/u);
  expect(dialog).toMatch(/data-motion=\{motion\}/u);
  expect(panel).toMatch(/<Dialog open=\{open\}/u);
  expect(panel).toMatch(/motion="palette"/u);
});
