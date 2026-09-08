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
  const mobile = page.viewportSize()!.width <= 640;
  const target = mobile
    ? sidebar.getByRole("button", { name: "스페이스 메뉴", exact: true })
    : row.locator('button[aria-haspopup="menu"]');
  await target.hover();
  const surface = await target.evaluate(button => {
    const rect = button.getBoundingClientRect();
    const css = getComputedStyle(button);
    return { width: rect.width, height: rect.height, size: css.backgroundSize,
      image: css.backgroundImage, position: css.backgroundPosition, color: css.backgroundColor };
  });
  assert.equal(surface.width, mobile ? 44 : 30);
  assert.equal(surface.height, mobile ? 44 : 30);
  assert.equal(surface.size, mobile ? "28px 28px" : "24px 24px");
  assert.equal(surface.position, "50% 50%");
  assert(surface.image.startsWith("radial-gradient("), JSON.stringify(surface));
  assert.equal(surface.color, "rgba(0, 0, 0, 0)");
  await page.screenshot({ path: screenshot.replace(".png", "-hover.png") });
  // Transparent side lies outside the painted circle but inside the unchanged button.
  await target.click({ position: { x: 1, y: surface.height / 2 } });
  await page.getByRole("menu").waitFor();
  await page.keyboard.press("Escape");
  await page.mouse.move(page.viewportSize()!.width - 2, page.viewportSize()!.height - 2);
  await page.screenshot({ path: screenshot });
  await sidebar.getByRole("tab").nth(2).click();
  assert.equal(await sidebar.getByRole("button", { name: "그룹 만들기", exact: true }).count(), 0);
  assert.equal(await sidebar.getByText("확인이 필요한 대화도 포함합니다.", { exact: true }).count(), 0);
  await sidebar.getByRole("tab").nth(0).click();
}
