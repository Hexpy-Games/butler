/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Source contract (like CommandPanel): product tests mock "@/butler-ds" (Dialog,
// DialogForm) for the rest of the bun process, so rendering here is order-dependent.
const source = readFileSync(new URL("./DialogForm.tsx", import.meta.url), "utf8");

test("inside a Dialog, the visible title and description are the dialog's title and description", () => {
  expect(source).toMatch(/dialog \? <DialogTitle asChild>\{heading\}<\/DialogTitle> : heading/u);
  expect(source).toMatch(/body && dialog \? <DialogDescription asChild>\{body\}<\/DialogDescription> : body/u);
});

test("busy marks the form busy while it submits", () => {
  expect(source).toContain("aria-busy={busy || undefined}");
  expect(source).toMatch(/event\.preventDefault\(\);\s*onSubmit\?\.\(\);/u);
});
