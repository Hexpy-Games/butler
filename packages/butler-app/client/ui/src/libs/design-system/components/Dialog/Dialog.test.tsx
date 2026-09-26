/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dialogContentAttributes } from "./index";

const css = readFileSync(new URL("./Dialog.module.css", import.meta.url), "utf8");
const source = readFileSync(new URL("../../shadcn/ui/dialog.tsx", import.meta.url), "utf8");

test("DialogContent sizes through a token-backed size prop, default sm", () => {
  expect(css).toMatch(/\.content\[data-size="xl"\]\s*\{[^}]*--dialog-width:\s*var\(--dialog-width-xl\)/u);
  expect(css).toMatch(/width:\s*min\(var\(--dialog-width\),/u);
  const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");
  for (const size of ["sm", "md", "lg", "xl"]) expect(tokens).toContain(`--dialog-width-${size}:`);
  expect(dialogContentAttributes({})).toEqual({ "data-size": "sm", "data-layout": "flow", "data-max-height": undefined });
});

test("scroll-body layout stacks header, scrolling body and footer; maxHeight caps it", () => {
  expect(css).toMatch(/\.content\[data-layout="scroll-body"\]\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/u);
  expect(css).toMatch(/\.content\[data-max-height="3\/5"\]\s*\{[^}]*max-height:\s*60%/u);
  expect(dialogContentAttributes({ size: "lg", layout: "scroll-body", maxHeight: "3/5" }))
    .toEqual({ "data-size": "lg", "data-layout": "scroll-body", "data-max-height": "3/5" });
  expect(source).toContain("{...dialogContentAttributes({ size, layout, maxHeight })}");
});

test("DialogTitle visuallyHidden keeps the accessible name without the title style", () => {
  // Source contract: product tests mock "@/butler-ds" Dialog parts for the rest of the process.
  expect(source).toContain('className={cn(visuallyHidden ? "sr-only" : styles.title, className)}');
});
