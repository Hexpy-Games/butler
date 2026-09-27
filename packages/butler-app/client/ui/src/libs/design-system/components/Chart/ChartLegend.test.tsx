/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { CHART_COLORS, ChartLegend, LegendSwatch, chartColor } from "./ChartLegend";

const css = readFileSync(new URL("./Chart.module.css", import.meta.url), "utf8").replace(/\s+/gu, " ");

test("chart colors map to the chart and status tokens, for fills and legends alike", () => {
  expect(chartColor("chart-1")).toBe("var(--context-chart-1)");
  expect(chartColor("chart-6")).toBe("var(--context-chart-6)");
  expect(chartColor("success")).toBe("var(--color-success)");
  expect(chartColor("warning")).toBe("var(--color-warning)");
  expect(chartColor("danger")).toBe("var(--color-danger)");
  for (const color of CHART_COLORS) {
    expect(css).toContain(`.swatch[data-color="${color}"] { background: ${chartColor(color)}; }`);
  }
});

test("the legend lists labelled swatches without inline styles", () => {
  const markup = renderToStaticMarkup(
    <ChartLegend items={[
      { key: "created", label: "Created", color: "chart-1" },
      { key: "failed", label: "Failed", color: "danger", shape: "bar" },
    ]} />,
  );
  const doc = new JSDOM(markup).window.document;
  const legend = doc.querySelector('[data-slot="chart-legend"]')!;
  expect(legend.tagName).toBe("UL");
  const items = [...legend.querySelectorAll("li")];
  expect(items.map((item) => item.textContent)).toEqual(["Created", "Failed"]);
  const swatches = [...legend.querySelectorAll('[data-slot="legend-swatch"]')];
  expect(swatches.map((swatch) => [swatch.getAttribute("data-color"), swatch.getAttribute("data-shape")])).toEqual([["chart-1", "dot"], ["danger", "bar"]]);
  expect(swatches.every((swatch) => swatch.getAttribute("aria-hidden") === "true")).toBe(true);
  expect(markup).not.toContain("style=");
});

test("a swatch alone is decorative", () => {
  const markup = renderToStaticMarkup(<LegendSwatch color="warning" />);
  expect(markup).toContain('data-color="warning"');
  expect(markup).toContain('aria-hidden="true"');
});
