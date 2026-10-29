// test-category: race
import { strict as assert } from "node:assert";
import type { Locator } from "playwright";

/** Compact context stays aligned while the session margin owns vertical scrolling. */
export async function verifyContextCompactLayout(context: Locator) {
  await context.waitFor();
  assert.equal(await context.locator("[data-context-group]").count(), 5);
  await context.getByRole("button", { name: "Details", exact: true }).click();
  await context.locator("[data-context-item]").first().waitFor();
  const state = await context.evaluate(root => {
    const row = root.querySelector('[data-context-group] [data-test-class~="key-value-row"]')!;
    const swatch = row.querySelector('[data-test-class~="key-value-swatch"]')!;
    const label = row.querySelector('[data-test-class~="key-value-label"]')!;
    const value = row.querySelector('[data-test-class~="key-value-value"]')!;
    const chart = root.querySelector('[role="img"]')!;
    const margin = root.closest('[data-slot="conversation-aside-scroll"]')!;
    const center = (element: Element) => { const box = element.getBoundingClientRect(); return box.y + box.height / 2; };
    return {
      swatchCenter: center(swatch), labelCenter: center(label),
      labelSize: getComputedStyle(label).fontSize, valueSize: getComputedStyle(value).fontSize,
      rowRight: row.getBoundingClientRect().right, chartRight: chart.getBoundingClientRect().right,
      horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
      nestedScrollers: [...root.querySelectorAll("*")].filter(node => node.scrollHeight > node.clientHeight && /auto|scroll/u.test(getComputedStyle(node).overflowY)).length,
      marginOverflows: margin.scrollHeight > margin.clientHeight + 8,
      marginScrollbar: getComputedStyle(margin).scrollbarWidth,
    };
  });
  assert(Math.abs(state.swatchCenter - state.labelCenter) <= 0.5, JSON.stringify(state));
  assert.equal(state.labelSize, state.valueSize);
  assert.equal(state.horizontalOverflow, false);
  assert.equal(state.nestedScrollers, 0);
  assert(state.marginOverflows, JSON.stringify(state));
  assert.equal(state.marginScrollbar, "thin");
  assert(Math.abs(state.rowRight - state.chartRight) <= 1.5, JSON.stringify(state));
  await context.getByText(/Auto-compacts at/u).waitFor();
}
