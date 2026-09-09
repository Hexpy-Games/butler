import { strict as assert } from "node:assert";
import type { Page } from "playwright";

/** Real painted/hit-tested boundaries, not source-shape assertions. */
export async function checkStickyClipping(page: Page, screenshot: string) {
  const scroll = page.locator('[data-test-class="sidebar-scroll"]');
  await scroll.evaluate(el => { el.scrollTop = 330; });
  await page.waitForTimeout(100);
  const measure = () => page.evaluate(() => {
    const regions = [...document.querySelectorAll<HTMLElement>("[data-sticky-clip]")];
    return regions.map(body => {
      const header = body.previousElementSibling!;
      const rect = body.getBoundingClientRect();
      const head = header.getBoundingClientRect();
      const clip = Number.parseFloat(getComputedStyle(body).clipPath.match(/inset\(([^ ]+)/)?.[1] ?? "0");
      const required = Math.max(0, Math.min(rect.height, head.bottom - rect.top));
      // Probe the obscured body, including transparent gaps in its covering header.
      const y = Math.min(head.bottom - 1, rect.bottom - 1);
      const hit = y > rect.top && y > 0 ? document.elementFromPoint(rect.left + rect.width / 2, y) : null;
      return { kind: body.dataset.stickyClip, clip, required,
        hiddenHit: Boolean(hit && required > 1 && body.contains(hit)) };
    });
  });
  let clipped = 0;
  let nestedClipped = false;
  for (const top of [330, 390, 440, 500, 580, 660, 800, 440, 0]) {
    await scroll.evaluate((el, value) => { el.scrollTop = value; }, top);
    await page.waitForTimeout(50);
    for (const region of await measure()) {
      assert(Math.abs(region.clip - region.required) < 1, JSON.stringify(region));
      assert(!region.hiddenHit, `clipped content must not receive pointer input: ${JSON.stringify(region)}`);
      if (region.kind === "branch" && region.required > 0) clipped++;
    }
    nestedClipped ||= await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-sticky-clip="branch"] [data-sticky-clip="branch"]')]
        .some(el => Number.parseFloat(el.style.getPropertyValue("--sticky-clip-top")) > 0));
  }
  assert(clipped > 0, "fixture must exercise a pinned branch");
  assert(nestedClipped, "fixture must exercise a pinned nested branch");
  await scroll.evaluate(el => { el.scrollTop = 330; });
  await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height - 2);
  await page.waitForTimeout(100);
  await page.screenshot({ path: screenshot });
  // Focus a clipped session: normal keyboard navigation must reveal it.
  const row = page.locator('[aria-label="대화 목록"]').getByRole("button", { name: "검증 대화 1", exact: true });
  await row.focus();
  await page.waitForTimeout(50);
  assert(await row.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  }), "focused row must be visible and hit-testable");
  // Wheel events use the original scroll container, no interception or second scroll.
  await scroll.hover();
  for (const delta of [400, 500, -600, -400]) await page.mouse.wheel(0, delta);
  await page.waitForTimeout(100);
  for (const region of await measure()) assert(Math.abs(region.clip - region.required) < 1);
  await scroll.evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(50);
  // Desktop hover replaces the disclosure icon with the menu; the label always toggles.
  await page.getByText("디자인", { exact: true }).click();
  await page.getByText("디자인", { exact: true }).click();
  const size = page.viewportSize()!;
  await page.setViewportSize({ ...size, height: size.height - 100 });
  await scroll.evaluate(el => { el.scrollTop = 400; });
  await page.waitForTimeout(100);
  for (const region of await measure()) assert(Math.abs(region.clip - region.required) < 1);
  // Negative control: reproduces the former transparent, non-clipping surface.
  const noClip = await page.addStyleTag({ content: "[data-sticky-clip] { clip-path: none !important; }" });
  assert((await measure()).some(region => region.required > 1 && region.clip === 0),
    "regression check must detect the old non-clipping implementation");
  await noClip.evaluate(el => el.parentNode?.removeChild(el));
  await page.setViewportSize(size);
  await scroll.evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(100);
  const list = page.locator('[aria-label="대화 목록"]');
  const source = list.getByRole("button", { name: "검증 대화 4", exact: true });
  const target = list.getByRole("button", { name: "검증 대화 3", exact: true });
  await source.dragTo(target, { targetPosition: { x: 12, y: 2 } });
  await page.waitForFunction(() => {
    const labels = [...document.querySelectorAll('[aria-label="대화 목록"] [data-test-class="tree-row"][aria-label]')]
      .map(el => el.getAttribute("aria-label"));
    return labels.indexOf("검증 대화 4") < labels.indexOf("검증 대화 3");
  });
  await target.dragTo(source, { targetPosition: { x: 12, y: 2 } });
  await page.waitForTimeout(100);
}
