import { strict as assert } from "node:assert";
import type { Page } from "playwright";

export async function checkSidebarRowControls(page: Page, screenshot: string) {
  const sidebar = page.locator('[data-test-class="app-sidebar"]');
  await sidebar.getByRole("tab").nth(1).click();
  await page.waitForTimeout(100);
  const row = sidebar.locator('[data-test-class="tree-row"]:has([data-slot="nav-row-meta"])').first();
  await row.waitFor();
  const result = await row.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const meta = el.querySelector('[data-slot="nav-row-meta"]')!.getBoundingClientRect();
    const time = el.querySelector("time")!.getBoundingClientRect();
    const button = el.querySelector('button[aria-haspopup="menu"]')!;
    const action = button.getBoundingClientRect();
    return { edge: rect.right - action.right, timeInset: rect.right - time.right,
      metaRight: meta.right, timeRight: time.right, metaTop: meta.top, actionTop: action.top,
      rowRadius: getComputedStyle(el).borderRadius, actionRadius: getComputedStyle(button).borderRadius };
  });
  assert(Math.abs(result.edge) < 1, JSON.stringify(result));
  assert.equal(result.timeInset, 8);
  assert.equal(result.metaRight, result.timeRight);
  assert(result.actionTop < result.metaTop);
  assert.equal(result.rowRadius, result.actionRadius);
  assert.equal(await sidebar.getByRole("button", { name: "그룹 만들기", exact: true }).count(), 0);
  await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height - 2);
  await page.screenshot({ path: screenshot });
  await sidebar.getByRole("tab").nth(2).click();
  assert.equal(await sidebar.getByRole("button", { name: "그룹 만들기", exact: true }).count(), 0);
  assert.equal(await sidebar.getByText("확인이 필요한 대화도 포함합니다.", { exact: true }).count(), 0);
  await sidebar.getByRole("tab").nth(0).click();
}
