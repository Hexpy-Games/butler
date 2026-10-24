import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import type { NavigationView } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { LEGACY_FIRST_RUN_STORAGE_KEY as FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";

const dir = mkdtempSync(join(tmpdir(), "butler-drag-scroll-"));
const server = await createNativeAppServer({
  butlerData: join(dir, "data"), uiRoot: resolve("packages/butler-app/client/ui/dist"),
});
const navigation = () => server.api<NavigationView>("/navigation");
await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko" }) });
for (let index = 0; index < 45; index++) {
  await server.api("/space/groups", { method: "POST", body: JSON.stringify({
    title: `Folder ${index}`, parentKey: null,
    expectedRevision: (await navigation()).space.revision,
  }) });
}
const browser = await launchSmokeBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 550 } });
  await server.signIn(page);
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: FIRST_RUN_STORAGE_KEY, value: legacyFirstRunCompleteRecord(),
  });
  await page.goto(server.url);
  const show = page.getByRole("button", { name: "사이드바 보기", exact: true });
  const sidebar = page.locator('[data-test-class="app-sidebar"]');
  await sidebar.waitFor();
  if (await sidebar.getAttribute("data-collapsed") === "true") {
    await show.waitFor();
    await show.click();
  }
  const scroll = page.locator('[data-test-class="sidebar-scroll"]');
  const source = page.locator('[data-tree-item^="g:"]:visible').first();
  await source.waitFor();
  // Scroll-driven animations follow scroll position, not time, and never finish.
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.timeline !== document.timeline || animation.effect?.getTiming().iterations === Infinity ||
      animation.playState !== "running"));
  const sourceKey = await source.getAttribute("data-tree-item");
  assert(sourceKey);
  const from = await source.boundingBox();
  const area = await scroll.boundingBox();
  assert(from && area);
  await page.mouse.move(from.x + 40, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(from.x + 45, from.y + 38, { steps: 8 });
  await page.mouse.move(area.x + 90, area.y + area.height - 12, { steps: 15 });
  const downBefore = await scroll.evaluate((element) => element.scrollTop);
  // Resting at the bottom edge scrolls down and pages in more groups.
  await page.waitForFunction((before) => {
    const element = document.querySelector<HTMLElement>('[data-test-class="sidebar-scroll"]');
    return element && element.scrollTop > before && document.querySelectorAll('[data-tree-item^="g:"]').length > 30;
  }, downBefore);
  const downAfter = await scroll.evaluate((element) => element.scrollTop);
  const loaded = await page.locator('[data-tree-item^="g:"]').count();
  const sticky = await page.locator('[data-test-class="sidebar-sticky-header"]').boundingBox();
  assert(sticky);
  await page.mouse.move(area.x + 90, sticky.y + sticky.height + 8, { steps: 30 });
  await page.mouse.move(area.x + 91, sticky.y + sticky.height + 8);
  const upBefore = await scroll.evaluate((element) => element.scrollTop);
  // Resting below the sticky header scrolls back up.
  await page.waitForFunction((before) =>
    document.querySelector<HTMLElement>('[data-test-class="sidebar-scroll"]')!.scrollTop < before, upBefore);
  const upAfter = await scroll.evaluate((element) => element.scrollTop);
  await page.mouse.move(area.x + 90, area.y + area.height - 12, { steps: 30 });
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLElement>('[data-test-class="sidebar-scroll"]');
    return element && element.scrollHeight - element.clientHeight - element.scrollTop < 2
      && document.querySelectorAll('[data-tree-item^="g:"]').length === 45;
  });
  const target = page.locator('[data-tree-item^="g:"]').last();
  const targetKey = await target.getAttribute("data-tree-item");
  const header = target.locator('[data-test-class="tree-row"]');
  const targetRow = await header.boundingBox();
  assert(targetKey && targetRow);
  await page.mouse.move(targetRow.x + 25, targetRow.y + 2, { steps: 12 });
  // A resting OS drag keeps sending dragover; Playwright sends one per move, so nudge the
  // pointer, following the row while the list finishes scrolling.
  for (let step = 0, deadline = Date.now() + 30_000; await target.getAttribute("data-drop") !== "before"; step++) {
    assert(Date.now() < deadline, "drop slot before the last folder never appeared");
    const row = await header.boundingBox();
    assert(row);
    await page.mouse.move(row.x + 25, row.y + 2 + step % 2);
  }
  await page.mouse.up();
  const rootOrder = async () => (await navigation()).space.nodes.filter(node => node.parentKey === null)
    .sort((a, b) => a.position - b.position).map(node => node.key);
  // The drop lands the folder right before the last one.
  for (let order = await rootOrder(), deadline = Date.now() + 30_000;
    order.indexOf(sourceKey) !== order.indexOf(targetKey) - 1; order = await rootOrder()) {
    assert(Date.now() < deadline, `dropped folder order: ${JSON.stringify(order)}`);
  }
  console.log(JSON.stringify({ downBefore, downAfter, upBefore, upAfter, loaded }));
  await page.close();
} finally {
  await browser.close();
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
