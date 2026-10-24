// test-category: race
import { strict as assert } from "node:assert";
import type { Page } from "playwright";
import { auditTabOrder, probeFocusRing } from "./focus-ring-clipping.ts";

export async function auditTagPicker(page: Page, count: number) {
  const popover = page.locator('[data-slot="filtered-select-popover"]');
  const box = await popover.boundingBox();
  assert(box && box.x >= 0 && box.x + box.width <= page.viewportSize()!.width, "Picker stays within viewport");
  assert.equal(await popover.locator('[data-slot="filtered-select-item"]').count(), count, "All tags are rendered");
  const results = popover.locator('[data-slot="filtered-select-results"]');
  await results.evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector('[data-slot="filtered-select-results"]')?.getAttribute("data-at-start") === "true");
  const metrics = await results.evaluate(element => {
    const css = getComputedStyle(element);
    return { height: element.clientHeight, total: element.scrollHeight, fade: css.getPropertyValue("--scroll-fade-end"),
      overflowing: element.getAttribute("data-overflowing"), mask: css.maskImage };
  });
  assert(metrics.total > metrics.height && metrics.overflowing === "true", "Palette overflows the scroll area");
  assert(parseFloat(metrics.fade) > 0 && metrics.mask !== "none", "Overflow has the DS edge fade");
  // The list must end mid-row: a sliver hidden inside the fade gives no cue that more tags follow.
  const peek = await results.evaluate(element => {
    const bottom = element.getBoundingClientRect().bottom;
    const cut = [...element.querySelectorAll('[data-slot="filtered-select-row"]')].map(row => row.getBoundingClientRect()).find(row => row.bottom > bottom);
    return cut ? (bottom - cut.top) / cut.height : 0;
  });
  assert(peek >= 0.3 && peek <= 0.7, `The first hidden tag row peeks above the edge (${peek.toFixed(2)})`);
  await results.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => document.querySelector('[data-slot="filtered-select-results"]')?.getAttribute("data-at-end") === "true");
  const last = await popover.locator('[data-slot="filtered-select-item"]').last().boundingBox();
  const scroll = await results.boundingBox();
  assert(last && scroll && last.y >= scroll.y && last.y + last.height <= scroll.y + scroll.height, "Last tag is reachable");
  await popover.getByRole("textbox").focus();
  const audit = await auditTabOrder(page, { within: '[data-slot="filtered-select-popover"]', maxStops: count * 2 + 8 });
  assert.equal(audit.clipped.length, 0, JSON.stringify(audit.clipped));
  assert(audit.visited.some(label => label.includes("태그 메뉴")), "Picker pencils were audited");
  await popover.getByRole("textbox").focus();
  await results.evaluate(element => { element.scrollTop = 0; });
  console.log(JSON.stringify({ result: "TAG_PICKER_AUDIT", ...metrics, clipped: audit.clipped.length, stops: audit.stops }));
}

export async function auditTagRow(page: Page) {
  const trigger = page.locator('[data-test-class="canon-tags-field"]').getByRole("combobox");
  await trigger.focus();
  // Keyboard navigation establishes :focus-visible before probing the real row control.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const probe = await probeFocusRing(page);
  assert(probe && !probe.noIndicator);
  assert.equal(probe.clips.length, 0, JSON.stringify(probe.clips));
}
