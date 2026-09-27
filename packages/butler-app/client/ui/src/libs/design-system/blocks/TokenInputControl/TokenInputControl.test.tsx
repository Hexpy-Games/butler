/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveTokenCommit, TokenInputControl } from "./TokenInputControl";

test("renders a numeric input, a DS slider and a value / max readout without chips", () => {
  const document = new JSDOM(renderToStaticMarkup(
    <TokenInputControl id="limit" inputLabel="Context limit" sliderLabel="Context limit slider"
      describedBy="limit-help" value={120000} min={1000} max={400000} onCommit={() => undefined} />,
  )).window.document;
  const input = document.querySelector("input#limit")!;
  expect(input.getAttribute("inputmode")).toBe("numeric");
  expect(input.getAttribute("aria-describedby")).toBe("limit-help");
  const slider = document.querySelector('[data-slot="slider"]')!;
  expect(slider.getAttribute("step")).toBe("1000");
  expect(slider.getAttribute("max")).toBe("400000");
  expect(document.body.textContent).toContain("120,000 / 400,000");
  expect(document.querySelector('[data-slot="token"]')).toBeNull();
});

test("commits parse separators, clamp to the range and report clamping", () => {
  const bounds = { min: 1000, max: 400000 };
  expect(resolveTokenCommit("120,000", 200000, bounds)).toEqual({ text: "120000", commit: { value: 120000, clamped: false } });
  expect(resolveTokenCommit("1_000_000", 200000, bounds)).toEqual({ text: "400000", commit: { value: 400000, clamped: true } });
  expect(resolveTokenCommit("12", 200000, bounds)).toEqual({ text: "1000", commit: { value: 1000, clamped: true } });
  expect(resolveTokenCommit("nope", 200000, bounds)).toEqual({ text: "200000", commit: null });
});
