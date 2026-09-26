/// <reference types="bun" />
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FieldError, FieldSeparator } from "./Field";

// The app has no Tailwind: utility class names from the shadcn source render
// nothing, so Field parts must style themselves through the Field CSS module.
const TAILWIND_UTILITY = /\b(?:absolute|inset-0|top-1\/2|ml-4|list-disc|flex-col|gap-1)\b/u;

test("FieldSeparator positions its line with the Field module, not Tailwind utilities", () => {
  const markup = renderToStaticMarkup(<FieldSeparator>or</FieldSeparator>);
  expect(markup).toContain('data-slot="separator"');
  expect(markup).not.toMatch(TAILWIND_UTILITY);
});

test("FieldError lists several unique errors without Tailwind utilities", () => {
  const markup = renderToStaticMarkup(
    <FieldError errors={[{ message: "Required" }, { message: "Too long" }, { message: "Required" }]} />,
  );
  expect(markup.match(/<li>/gu)?.length).toBe(2);
  expect(markup).not.toMatch(TAILWIND_UTILITY);
});
