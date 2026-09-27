/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricCard } from "./MetricCard";

function render(node: React.ReactNode) {
  return new JSDOM(renderToStaticMarkup(node)).window.document;
}

test("MetricCard renders numeric values through AnimatedNumber with tabular numerals", () => {
  const document = render(<MetricCard value={36460} format={(value) => value.toLocaleString("en-US")} label="Input tokens" />);
  const number = document.querySelector('[data-slot="animated-number"]')!;
  expect(number).not.toBeNull();
  expect(document.querySelector('[data-slot="animated-number-final"]')!.textContent).toBe("36,460");
  expect(document.querySelector('[data-slot="metric-value"]')!.getAttribute("data-numeric")).toBe("tabular");
  expect(document.querySelector('[data-slot="metric-label"]')!.textContent).toBe("Input tokens");
});

test("MetricCard keeps string values static", () => {
  const document = render(<MetricCard value="1.2K" label="Requests" />);
  expect(document.querySelector('[data-slot="animated-number"]')).toBeNull();
  expect(document.querySelector('[data-slot="metric-value"]')!.textContent).toBe("1.2K");
});
