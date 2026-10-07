// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { PercentInputControl, resolvePercentCommit } from "./PercentInputControl";

function render(node: React.ReactElement) {
  return new JSDOM(renderToStaticMarkup(node)).window.document;
}

test("renders a number input, a DS slider and a percent readout", () => {
  const document = render(
    <PercentInputControl id="budget" inputLabel="Budget percent value" sliderLabel="Budget percent slider"
      describedBy="budget-help" value={40} onCommit={() => true} />,
  );
  const input = document.querySelector("input#budget")!;
  expect(input.getAttribute("inputmode")).toBe("numeric");
  expect(input.getAttribute("aria-label")).toBe("Budget percent value");
  expect(input.getAttribute("aria-describedby")).toBe("budget-help");
  const slider = document.querySelector('[data-slot="slider"]')!;
  expect(slider.getAttribute("aria-label")).toBe("Budget percent slider");
  expect(slider.getAttribute("step")).toBe("5");
  expect(document.body.textContent).toContain("40%");
});

test("commits clamp and round to the bounds and skip unchanged values", () => {
  expect(resolvePercentCommit("62.4", 40, { min: 0, max: 100 })).toEqual({ text: "62", commit: 62 });
  expect(resolvePercentCommit("140", 40, { min: 0, max: 100 })).toEqual({ text: "100", commit: 100 });
  expect(resolvePercentCommit("abc", 40, { min: 0, max: 100 })).toEqual({ text: "0", commit: 0 });
  expect(resolvePercentCommit("40", 40, { min: 0, max: 100 })).toEqual({ text: "40", commit: null });
  expect(resolvePercentCommit("10", 50, { min: 40, max: 90 })).toEqual({ text: "40", commit: 40 });
});
