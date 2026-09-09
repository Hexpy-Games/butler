import { strict as assert } from "node:assert";
import type { Page } from "playwright";

export async function checkSidebarProjectControls(page: Page, screenshot: string) {
  const sidebar = page.locator('[data-test-class="app-sidebar"]');
  const title = sidebar.getByText("프로젝트 검증", { exact: true });
  const row = sidebar.locator('[data-test-class="tree-row"]').filter({ has: page.getByText("프로젝트 검증", { exact: true }) });
  await row.scrollIntoViewIfNeeded();
  await page.mouse.move(page.viewportSize()!.width - 2, 1);
  await title.evaluate(el => (el.ownerDocument.activeElement as HTMLElement)?.blur());
  const dashboard = row.getByRole("button", { name: "프로젝트 검증 프로젝트 대시보드", exact: true });
  await dashboard.waitFor();
  const menu = row.locator('button[aria-haspopup="menu"]');
  const metrics = await row.evaluate(el => {
    const buttons = [...el.querySelectorAll("button")];
    const dashboardRect = buttons[0]!.getBoundingClientRect();
    const chevron = buttons[1]!.getBoundingClientRect();
    const menuRect = buttons[2]!.getBoundingClientRect();
    const more = document.querySelector('[data-test-class="sidebar-load-more"] [data-slot="nav-row-label"] span')!;
    return { gap: chevron.left - dashboardRect.right, sameSlot: chevron.x === menuRect.x,
      width: dashboardRect.width, menuVisible: getComputedStyle(buttons[2]!).visibility,
      moreColor: getComputedStyle(more).color,
      expectedColor: getComputedStyle(el).getPropertyValue("--text-secondary").trim(),
      identity: el.querySelector('[data-slot="nav-row-icon"] svg')?.innerHTML,
      dashboard: buttons[0]!.querySelector("svg")?.innerHTML };
  });
  assert.equal(metrics.gap, 2);
  assert(metrics.sameSlot);
  assert.equal(metrics.width, page.viewportSize()!.width <= 640 ? 44 : 30);
  assert.equal(metrics.menuVisible, "hidden");
  assert(metrics.identity && metrics.identity !== metrics.dashboard);
  const headingButtons = [sidebar.getByRole("button", { name: "그룹 만들기", exact: true }),
    sidebar.getByRole("button", { name: "스페이스 메뉴", exact: true })];
  const headerRects = await Promise.all(headingButtons.map(button => button.boundingBox()));
  const dashboardRect = (await dashboard.boundingBox())!;
  const menuRect = (await menu.boundingBox())!;
  assert.equal(headerRects[0]!.x + headerRects[0]!.width / 2, dashboardRect.x + dashboardRect.width / 2);
  assert.equal(headerRects[1]!.x + headerRects[1]!.width / 2, menuRect.x + menuRect.width / 2);
  // Compare resolved semantic color (tokens may themselves contain color functions).
  assert(await row.evaluate((el, color) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-secondary)";
    el.append(probe);
    const equal = getComputedStyle(probe).color === color;
    probe.remove();
    return equal;
  }, metrics.moreColor));
  await title.click();
  assert.equal(await row.getAttribute("aria-expanded"), "false");
  await title.click();
  assert.equal(await row.getAttribute("aria-expanded"), "true");
  if (page.viewportSize()!.width > 640) {
    await row.hover();
    assert(await menu.isVisible());
    assert.equal(await row.locator("button").nth(1).isVisible(), false);
    await menu.click();
    await page.getByRole("menu").waitFor();
    await page.keyboard.press("Escape");
  } else {
    const chevron = row.locator("button").nth(1);
    await chevron.click();
    assert.equal(await row.getAttribute("aria-expanded"), "false");
    await chevron.click();
    // Touch context menu retains the same public long-press handler.
    await title.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 1, button: 0, isPrimary: true });
    await page.getByRole("menu").waitFor();
    await title.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 1 });
    await title.dispatchEvent("click");
    await page.keyboard.press("Escape");
  }
  await page.screenshot({ path: screenshot });
  await dashboard.click();
  await page.locator('[data-test-class="project-dashboard-view"]').waitFor();
  assert.equal(await row.getAttribute("aria-expanded"), "true");
}
