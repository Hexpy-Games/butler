// Node --experimental-strip-types; real Electron/browser renderer on Vite, no project mutations or messages.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP(process.env.DASHBOARD_CDP ?? "http://127.0.0.1:9224");
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(":5173"));
assert(page, "Open the real Butler renderer");
const oldViewport = page.viewportSize();
const sidebarState = () => page.locator('[data-left-open]').getAttribute('data-left-open').then(value => ({ open: value === "true" }));
try {
  await page.setViewportSize({ width: 1280, height: 900 });
  const show = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (!(await sidebarState()).open) await show.click();
  await page.getByRole("button", { name: "sandy-bot 프로젝트 대시보드", exact: true }).click();
  assert.equal((await sidebarState()).open, true, "Expanded navigation preserves sidebar");
  const heading = page.locator('[data-test-class="project-dashboard-view"]').getByText("sandy-bot", { exact: true }).first();
  await heading.waitFor();
  for (const title of ["sandy-bot", "식혜"]) {
    const disclosure = page.getByRole("button", { name: new RegExp(`^${title} (접기|펼치기)$`), includeHidden: true });
    const row = page.locator('[data-test-class="tree-row"]').filter({ has: disclosure });
    const menu = page.getByRole("button", { name: `${title} 메뉴`, exact: true, includeHidden: true });
    await row.hover();
    await menu.click();
    await page.getByRole("menu").waitFor();
    await heading.click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await page.waitForTimeout(160); // Sidebar action opacity transition is 120 ms.
    assert.equal(await disclosure.isVisible(), true, `${title}: pointer dismissal restores chevron`);
    assert.deepEqual(await menu.evaluate(el => ({ opacity: getComputedStyle(el.closest('[data-button-size]')!).opacity,
      pointerEvents: getComputedStyle(el.closest('[data-button-size]')!).pointerEvents })),
      { opacity: "0", pointerEvents: "none" }, `${title}: no sticky more button`);
    // Keyboard access is retained even when hover is elsewhere.
    await row.focus();
    await page.keyboard.press("Tab");
    if (title === "sandy-bot") await page.keyboard.press("Tab"); // Dashboard shortcut precedes the menu.
    assert.equal(await menu.evaluate(el => document.activeElement === el), true, `${title}: Tab reaches more menu`);
    await page.keyboard.press("Enter");
    await page.getByRole("menu").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
    await page.waitForTimeout(160); // Radix restores trigger focus after the close animation unmounts.
    assert.equal(await menu.evaluate(el => document.activeElement === el), true, "Keyboard focus returns to trigger");
    await heading.click();
  }
  await page.screenshot({ path: "/tmp/butler-r4-sidebar-desktop.png", animations: "disabled" });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(350); // Existing adaptive pane transition.
    if (!(await sidebarState()).open) await show.click();
    await page.getByRole("button", { name: "sandy-bot 프로젝트 대시보드", exact: true }).click();
    assert.deepEqual(await sidebarState(), { open: false });
    assert.equal(await page.locator('[data-test-class="project-dashboard-view"]').isVisible(), true);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `/tmp/butler-r4-sidebar-${width}.png`, animations: "disabled" });
  }
  console.log("PASS: project/group pointer + keyboard menus; desktop preserves sidebar; 390/320 dashboard click closes sidebar");
} finally {
  if (oldViewport) await page.setViewportSize(oldViewport);
  else {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.clearDeviceMetricsOverride");
    await session.detach();
  }
  await browser.close();
}
