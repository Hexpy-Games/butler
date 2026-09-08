import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server";
import { FIRST_RUN_STORAGE_KEY, firstRunCompleteState } from "../../packages/butler-app/client/ui/src/app/firstRunSetup";
import { snapshotForAppUiState } from "../../packages/butler-app/client/ui/src/app/appUiStateCache";
import { readFirstChatOnboardingState, writeFirstChatOnboardingState } from "../../packages/butler-agent/src/personalization/onboarding";

const dir = mkdtempSync(join(tmpdir(), "butler-panel-resize-"));
writeFirstChatOnboardingState(dir, { ...readFirstChatOnboardingState(dir), status: "complete", completed_at: new Date().toISOString() });
const server = createTestAppServer({ butlerData: dir, dbPath: join(dir, "app.sqlite"), uiRoot: resolve("packages/butler-app/client/ui/dist"), port: 0 });
server.store.updateSettings({ language: "ko" });
const session = server.store.createSession({ kind: "chat", title: "패널 리사이즈 검증" }).session;
const browser = await chromium.launch({ headless: true });
const output = resolve(".tmp/panel-resize");
mkdirSync(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(({ key, firstRun, snapshot }) => {
    localStorage.setItem(key, JSON.stringify(firstRun));
    if (!localStorage.getItem("butler:app-ui-state:v1")) localStorage.setItem("butler:app-ui-state:v1", JSON.stringify(snapshot));
  }, { key: FIRST_RUN_STORAGE_KEY, firstRun: firstRunCompleteState("ko"), snapshot: snapshotForAppUiState({ active_session_id: session.id, left_open: true, right_open: true }) });
  await page.goto(server.url);
  const handle = page.locator("[data-test-class~='right-panel-resize-handle']");
  await handle.waitFor();
  const measure = () => page.evaluate(() => {
    const shell = document.querySelector('[data-panel-layout]')!;
    const main = shell.querySelector("main")!;
    const right = document.querySelector('[data-test-class="right-panel-slot"]')!;
    return { main: main.getBoundingClientRect().width, right: right.getBoundingClientRect().width,
      max: Number(document.querySelector('[data-test-class~="right-panel-resize-handle"]')?.getAttribute("aria-valuemax")),
      now: Number(document.querySelector('[data-test-class~="right-panel-resize-handle"]')?.getAttribute("aria-valuenow")),
      overflow: document.documentElement.scrollWidth > innerWidth };
  });
  const checkBoundary = async () => {
    await page.waitForTimeout(80);
    const geometry = await measure();
    assert.equal(geometry.main, 320, JSON.stringify(geometry));
    assert.equal(geometry.right, geometry.max);
    assert.equal(geometry.right, geometry.now);
    assert(!geometry.overflow);
    return geometry;
  };
  const rect = (await handle.boundingBox())!;
  await page.mouse.move(rect.x + rect.width / 2, rect.y + 100);
  await page.mouse.down();
  await page.mouse.move(1, rect.y + 100, { steps: 8 });
  await page.mouse.up();
  assert((await checkBoundary()).right > 520);
  const composer = page.locator('[data-test-class="composer-card"]');
  const composerRect = (await composer.boundingBox())!;
  assert(composerRect.width >= 280 && composerRect.width <= 320, JSON.stringify(composerRect));
  await composer.click();
  await page.waitForTimeout(100);
  assert(await composer.evaluate(el => {
    const bounds = el.getBoundingClientRect();
    return [...el.querySelectorAll("button")].filter(button => getComputedStyle(button).display !== "none" && button.getBoundingClientRect().width > 0)
      .every(button => { const r = button.getBoundingClientRect(); return r.left >= bounds.left - 1 && r.right <= bounds.right + 1; });
  }), "composer actions must fit the narrow conversation");
  await page.screenshot({ path: join(output, "desktop-main-320.png") });
  const hideLeft = page.getByRole("button", { name: "사이드바 숨기기", exact: true });
  await hideLeft.click();
  await handle.focus();
  await page.keyboard.press("End");
  const wide = await checkBoundary();
  assert.equal(wide.right, 1120);
  await page.setViewportSize({ width: 1100, height: 1000 });
  await checkBoundary();
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal((await checkBoundary()).right, wide.right);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("butler:app-ui-state:v1") ?? "{}").right_panel_width === 1120);
  await page.reload();
  await handle.waitFor();
  await checkBoundary();
  await page.keyboard.press("Tab");
  await handle.focus();
  await page.keyboard.press("Home");
  await page.waitForTimeout(80);
  assert.equal((await measure()).right, 292);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.equal((await measure()).main, 390);
  assert.equal(await handle.isVisible(), false);
  await page.screenshot({ path: join(output, "mobile-drawer-regression.png") });
  console.log("PASS pointer limit, keyboard Home/End, resize and cache restore, 320px main, mobile drawer");
} finally {
  await browser.close();
  server.stop();
}
