import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { FIRST_RUN_STORAGE_KEY, firstRunCompleteState } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";
import { readFirstChatOnboardingState, writeFirstChatOnboardingState } from "../../packages/butler-agent/src/personalization/onboarding.ts";

const dir = mkdtempSync(join(tmpdir(), "butler-drag-scroll-"));
writeFirstChatOnboardingState(dir, {
  ...readFirstChatOnboardingState(dir), status: "complete", completed_at: new Date().toISOString(),
});
const server = createTestAppServer({
  butlerData: dir, dbPath: join(dir, "app.sqlite"),
  uiRoot: resolve("packages/butler-app/client/ui/dist"), port: 0,
});
server.store.updateSettings({ language: "ko" });
for (let index = 0; index < 45; index++) {
  server.store.mutateSpace({
    action: "create", title: `Folder ${index}`, parentKey: null,
    expectedRevision: server.store.listNavigation().space.revision,
  });
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 550 } });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: FIRST_RUN_STORAGE_KEY, value: firstRunCompleteState("ko"),
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
  await page.waitForTimeout(250);
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
  await page.waitForTimeout(800);
  const downAfter = await scroll.evaluate((element) => element.scrollTop);
  const loaded = await page.locator('[data-tree-item^="g:"]').count();
  assert(downAfter > downBefore, `downward auto scroll: ${downBefore} -> ${downAfter}`);
  assert(loaded > 30, `drag paging: ${loaded} groups`);
  const sticky = await page.locator('[data-test-class="sidebar-sticky-header"]').boundingBox();
  assert(sticky);
  await page.mouse.move(area.x + 90, sticky.y + sticky.height + 8, { steps: 30 });
  await page.waitForTimeout(200);
  await page.mouse.move(area.x + 91, sticky.y + sticky.height + 8);
  const upBefore = await scroll.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(650);
  const upAfter = await scroll.evaluate((element) => element.scrollTop);
  assert(upAfter < upBefore, `upward auto scroll: ${upBefore} -> ${upAfter}`);
  await page.mouse.move(area.x + 90, area.y + area.height - 12, { steps: 30 });
  await page.waitForFunction(() => {
    const element = document.querySelector<HTMLElement>('[data-test-class="sidebar-scroll"]');
    return element && element.scrollHeight - element.clientHeight - element.scrollTop < 2;
  });
  const target = page.locator('[data-tree-item^="g:"]').last();
  const targetKey = await target.getAttribute("data-tree-item");
  const targetRow = await target.locator('[data-test-class="tree-row"]').boundingBox();
  assert(targetKey && targetRow);
  await page.mouse.move(targetRow.x + 25, targetRow.y + 2, { steps: 12 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const order = server.store.listNavigation().space.nodes.filter(node => node.parentKey === null)
    .sort((a, b) => a.position - b.position).map(node => node.key);
  assert.equal(order.indexOf(sourceKey), order.indexOf(targetKey) - 1);
  console.log(JSON.stringify({ downBefore, downAfter, upBefore, upAfter, loaded }));
  await page.close();
} finally {
  await browser.close();
  server.stop();
  rmSync(dir, { recursive: true, force: true });
}
