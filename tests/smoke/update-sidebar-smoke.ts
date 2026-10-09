// Production footer and progress store, with the existing stub update feed.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { getAppCopy } from "../../packages/butler-i18n/src";

const root = resolve("packages/butler-app/client/ui/dist");
const output = resolve(".tmp/update-sidebar");
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(root, path === "/" ? "index.html" : path));
  return new Response(await file.exists() ? file : Bun.file(join(root, "index.html")));
} });
const browser = await launchSmokeBrowser();
const errors: string[] = [];
let cells = 0;
let maxDownloadTask = 0;
let testError: unknown;
let cleanupFailure: { error: unknown } | undefined;

async function nativeCalls(page: Page): Promise<Array<number | string | null>> {
  const button = page.locator('[data-test-id="harness-native-calls"]');
  await button.evaluate((element) => (element as HTMLButtonElement).click());
  return JSON.parse((await button.textContent())!);
}

async function geometry(page: Page, width: number, settingsName: string, stage: string, restartLabel: string) {
  const row = page.locator('[data-test-class="sidebar-update-row"]');
  const box = await row.boundingBox();
  const settings = page.locator('[data-test-class="app-sidebar"]').getByRole("button", { name: settingsName, exact: true });
  const setting = await settings.boundingBox();
  assert(box && setting);
  const touch = width === 375;
  const rowSize = touch ? 44 : 30;
  const iconSize = touch ? 20 : 16;
  assert.equal(box.height, rowSize);
  assert.equal(setting.height, box.height);
  assert.equal(setting.y - box.y - box.height, touch ? 8 : 4);
  assert.equal(setting.x, box.x);
  assert.equal(setting.width, box.width);
  assert(box.y >= 0 && setting.y + setting.height <= page.viewportSize()!.height, "footer stays in viewport");
  assert.equal(await row.evaluate((element) => element.scrollWidth > element.clientWidth), false);
  const gear = await settings.locator('[data-slot="nav-row-icon"] svg').boundingBox();
  assert(gear);
  assert.equal(gear.width, iconSize);
  assert.equal(gear.height, iconSize);
  assert.equal(gear.x - setting.x, 8);
  if (stage === "failed") {
    const alert = await row.locator('[data-slot="nav-row-icon"] svg').boundingBox();
    assert(alert);
    assert.equal(alert.width, iconSize);
    assert.equal(alert.height, iconSize);
    assert.equal(alert.x - box.x, 8);
  } else {
    const ring = row.locator('[data-slot="progress-ring"]');
    const ringBox = await ring.boundingBox();
    assert(ringBox);
    assert.equal(await ring.getAttribute("data-size"), "sidebar");
    assert.equal(ringBox.width, iconSize);
    assert.equal(ringBox.height, iconSize);
    assert.equal(ringBox.x - box.x, 8);
    assert.equal(ringBox.x, gear.x);
    if (stage === "ready") {
      const button = row.getByRole("button", { name: restartLabel, exact: true });
      const buttonBox = await button.boundingBox();
      const buttonIcon = await button.locator("svg").boundingBox();
      assert(buttonBox && buttonIcon);
      assert.equal(buttonBox.width, rowSize);
      assert.equal(buttonBox.height, rowSize);
      assert.equal(buttonBox.x + buttonBox.width, box.x + box.width);
      assert.equal(buttonIcon.width, iconSize);
      assert.equal(buttonIcon.height, iconSize);
      assert.equal(box.x + box.width - buttonIcon.x - buttonIcon.width, touch ? 12 : 7);
      assert.equal(await button.getAttribute("aria-label"), restartLabel);
      assert.equal(await button.getAttribute("data-variant"), "ghost");
      assert.equal(await button.getAttribute("data-size"), "icon-sm");
      const container = button.locator("xpath=..");
      assert.equal(await container.getAttribute("data-slot"), "button-container");
      assert.equal(await container.getAttribute("data-button-size"), "icon-sm");
    }
  }
}

try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const metrics = { frames: 0, writes: 0, longTasks: [] as number[] };
    Object.assign(window, { sidebarMetrics: metrics });
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => frame((time) => { metrics.frames++; callback(time); });
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { metrics.writes++; return write.call(this, key, value); };
    new PerformanceObserver((list) => metrics.longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask" });
  });
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) for (const locale of ["ko", "en"] as const) {
    const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US");
    const name = `${width}-${theme}-${locale}`;
    const url = `http://127.0.0.1:${server.port}/?visual=update-progress&sidebar&stage=idle&theme=${theme}&locale=${locale}`;
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${url}&baseline`);
    const settings = page.locator('[data-test-class="app-sidebar"]').getByRole("button", { name: copy.sidebar.settings, exact: true });
    await settings.waitFor();
    const before = await settings.boundingBox();
    await settings.screenshot({ path: join(output, `before-settings-${name}.png`) });
    await page.locator('[data-test-class="app-sidebar"]').screenshot({ path: join(output, `before-${name}.png`) });
    await page.goto(`${url.replace("stage=idle", "stage=completed")}&check-error=update_manifest_app_platform_missing`);
    await settings.waitFor();
    assert.equal(await page.locator('[data-test-class="sidebar-update-row"]').count(), 0, "fresh preview with missing stable platform has no failure label");
    await page.locator('[data-test-class="app-sidebar"]').screenshot({ path: join(output, `check-unavailable-${name}.png`) });
    await page.goto(url);
    await settings.waitFor();
    await page.locator('[data-test-class="sidebar-load-more"]').filter({ hasText: "(570)" }).waitFor();
    const row = page.locator('[data-test-class="sidebar-update-row"]');
    assert.equal(await row.count(), 0);
    assert.deepEqual(await settings.boundingBox(), before, "idle footer unchanged");
    await page.locator('[data-test-class="app-sidebar"]').screenshot({ path: join(output, `idle-${name}.png`) });
    for (const stage of ["checking", "downloading", "verifying", "ready", "applying", "restarting", "failed", "completed", "idle"]) {
      await page.locator(`[data-test-id="stage-${stage}"]`).evaluate((element) => (element as HTMLButtonElement).click());
      await page.locator(`[data-test-id="update-component-app"][data-stage="${stage}"]`).waitFor({ state: "attached" });
      if (["idle", "completed"].includes(stage)) {
        assert.equal(await row.count(), 0);
        assert.equal((await nativeCalls(page)).at(-1), null);
      } else {
        await row.waitFor();
        const label = stage === "downloading" ? copy.shell.update.downloading : stage === "ready" ? copy.shell.update.ready
          : stage === "failed" ? copy.shell.update.failed : copy.shell.update.working;
        assert.equal(await row.getAttribute("aria-label"), stage === "downloading" ? `${label} 42%` : label);
        await geometry(page, width, copy.sidebar.settings, stage, copy.shell.update.restart);
        const ring = row.locator('[data-slot="progress-ring"]');
        assert.equal(await ring.count(), stage === "failed" ? 0 : 1);
        if (stage !== "failed") {
          assert.equal(await ring.getAttribute("data-state"), stage === "ready" ? "complete" : stage === "downloading" ? "determinate" : "indeterminate");
          assert.equal(await ring.getAttribute("data-tone"), stage === "ready" ? "success" : "default");
          assert.equal(await ring.getAttribute("aria-hidden"), "true");
          assert.equal(await ring.locator('[data-slot="spinner"]').count(), stage === "ready" || stage === "downloading" ? 0 : 1);
          if (stage === "downloading") assert(Math.abs(await ring.evaluate((element) => Number.parseFloat(getComputedStyle(element).getPropertyValue("--progress-ring-offset"))) - 2 * Math.PI * 8 * .58) < .001);
        }
        assert.equal((await nativeCalls(page)).at(-1), stage === "failed" ? null : stage === "ready" ? 1 : stage === "downloading" ? .42 : "indeterminate");
        await row.screenshot({ path: join(output, `${stage}-row-${name}.png`) });
        await page.locator('[data-test-class="app-sidebar"]').screenshot({ path: join(output, `${stage}-${name}.png`) });
        if (stage === "ready") {
          const restart = row.getByRole("button", { name: copy.shell.update.restart, exact: true });
          await restart.hover();
          const tooltip = page.getByRole("tooltip");
          await tooltip.waitFor();
          assert.equal((await tooltip.textContent())?.trim(), copy.shell.update.restart);
          assert(await restart.getAttribute("aria-describedby"));
          await page.mouse.move(0, 0);
          await tooltip.waitFor({ state: "hidden" });
        }
      }
      cells++;
    }
    const calls = await nativeCalls(page);
    await page.waitForTimeout(500);
    const start = await page.evaluate(() => ({ ...(window as unknown as { sidebarMetrics: { frames: number; writes: number } }).sidebarMetrics }));
    await page.waitForTimeout(1000);
    const end = await page.evaluate(() => ({ ...(window as unknown as { sidebarMetrics: { frames: number; writes: number } }).sidebarMetrics }));
    assert.equal(end.frames - start.frames, 0, "no idle JS frames");
    assert.equal(end.writes - start.writes, 0, "zero idle storage writes");
    assert.deepEqual(await nativeCalls(page), calls, "no idle native calls");
    await page.locator('[data-test-id="stage-downloading"]').evaluate((element) => (element as HTMLButtonElement).click());
    await page.locator('[data-test-id="harness-bytes"]').evaluate((element) => (element as HTMLButtonElement).click());
    await row.locator('[data-state="indeterminate"]').waitFor();
    assert.equal(await row.getAttribute("aria-label"), copy.shell.update.downloading);
    assert.equal(await row.locator('[data-slot="progress-ring"]').getAttribute("data-size"), "sidebar");
    assert.equal(await row.locator('[data-slot="progress-ring"] [data-slot="spinner"]').count(), 1);
    assert.equal((await nativeCalls(page)).at(-1), "indeterminate");
    await page.locator('[data-test-id="stage-ready"]').evaluate((element) => (element as HTMLButtonElement).click());
    await page.locator('[data-test-id="harness-deferred"]').evaluate((element) => (element as HTMLButtonElement).click());
    assert.equal(await row.getByRole("button", { name: copy.shell.update.restart, exact: true }).isDisabled(), true);
    await page.locator('[data-test-id="harness-deferred"]').evaluate((element) => (element as HTMLButtonElement).click());
    await row.getByRole("button", { name: copy.shell.update.restart, exact: true }).click();
    await page.locator('[data-test-id="update-component-app"][data-stage="restarting"]').waitFor({ state: "attached" });
    await page.locator('[data-test-id="stage-downloading"]').evaluate((element) => (element as HTMLButtonElement).click());
    await page.locator('[data-test-id="harness-bytes"]').evaluate((element) => (element as HTMLButtonElement).click());
    await row.getByText("42%", { exact: true }).waitFor();
    const beforeRepeat = await nativeCalls(page);
    await page.locator('[data-test-id="harness-repeat"]').evaluate((element) => (element as HTMLButtonElement).click());
    assert.deepEqual(await nativeCalls(page), beforeRepeat, "sub-percent changes do not call native bridge");
    await page.waitForTimeout(500);
    await page.evaluate(() => { (window as unknown as { sidebarMetrics: { longTasks: number[] } }).sidebarMetrics.longTasks = []; });
    await page.locator('[data-test-id="harness-burst"]').evaluate((element) => (element as HTMLButtonElement).click());
    await row.getByText("100%", { exact: true }).waitFor();
    const downloadCalls = (await nativeCalls(page)).slice(beforeRepeat.length);
    assert.deepEqual(downloadCalls, Array.from({ length: 101 }, (_, index) => index / 100), "complete ordered percent feed");
    const tasks = await page.evaluate(() => (window as unknown as { sidebarMetrics: { longTasks: number[] } }).sidebarMetrics.longTasks);
    maxDownloadTask = Math.max(maxDownloadTask, ...tasks, 0);
    assert.equal(tasks.filter((duration) => duration > 50).length, 0, `no download long task >50ms: ${JSON.stringify(tasks)}`);
    await row.click();
    await page.locator('[data-test-id="harness-view"]').filter({ hasText: "settings:updates" }).waitFor({ state: "attached" });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, cells, chats: 600, rowHeights: [30, 44], actionSizes: [30, 44], restartIconSizes: [16, 20], restartIconRightInsets: [7, 12], ringSizes: [16, 20], ringLeftInset: 8, rowGaps: [4, 8], idleFrames: 0, idleStorageWrites: 0, idleNativeCalls: 0, maxDownloadTaskMs: maxDownloadTask, screenshots: output }));
} catch (error) { testError = error; throw error; }
finally {
  try { await browser.close(); } catch (error) { cleanupFailure = { error }; if (testError) console.error("Browser cleanup:", error); }
  finally { server.stop(true); }
}
if (cleanupFailure) throw cleanupFailure.error;
