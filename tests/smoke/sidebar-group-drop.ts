import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { FIRST_RUN_STORAGE_KEY, firstRunCompleteState } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";
import { readFirstChatOnboardingState, writeFirstChatOnboardingState } from "../../packages/butler-agent/src/personalization/onboarding.ts";

const dir = mkdtempSync(join(tmpdir(), "butler-group-drop-"));
writeFirstChatOnboardingState(dir, {
  ...readFirstChatOnboardingState(dir), status: "complete", completed_at: new Date().toISOString(),
});
const server = createTestAppServer({
  butlerData: dir, dbPath: join(dir, "app.sqlite"),
  uiRoot: resolve("packages/butler-app/client/ui/dist"), port: 0,
});
server.store.updateSettings({ language: "ko" });
const source = server.store.createSession({ kind: "chat", title: "사죽이 이야기" }).session;
const target = server.store.createSession({ kind: "chat", title: "죽랑이 이야기 이어가기" }).session;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: FIRST_RUN_STORAGE_KEY, value: firstRunCompleteState("ko"),
  });
  let groupRequests = 0;
  await page.route("**/space/group-sessions", async route => {
    groupRequests++;
    await new Promise(resolve => setTimeout(resolve, 700));
    await route.continue();
  });
  await page.goto(server.url);
  const sidebar = page.locator('[data-test-class="app-sidebar"]');
  await sidebar.waitFor();
  if (await sidebar.getAttribute("data-collapsed") === "true") {
    const show = page.getByRole("button", { name: "사이드바 보기", exact: true });
    await show.waitFor();
    await show.click();
  }
  const sourceRow = page.locator(`[data-tree-item="s:${source.id}"]`);
  const targetRow = page.locator(`[data-tree-item="s:${target.id}"]`);
  await sourceRow.waitFor();
  await targetRow.waitFor();
  await page.waitForTimeout(250);
  const from = await sourceRow.boundingBox();
  const to = await targetRow.locator('[data-test-class="tree-row"]').boundingBox();
  assert(from && to);
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 45, from.y + from.height / 2 + 12, { steps: 8 });
  await page.mouse.move(to.x + 45, to.y + to.height / 2, { steps: 16 });
  await page.waitForTimeout(150);
  console.log(JSON.stringify({ hint: await targetRow.getAttribute("data-drop") }));
  await page.mouse.up();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(groupRequests, 0, "drop opens the form without waiting for the server");
  assert.equal(server.store.listNavigation().space.groups.length, 0, "drop opens the form before creating a group");
  await dialog.locator("#space-group-title").fill("사슴벌레");
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('form[aria-busy="true"]').waitFor();
  assert.equal(groupRequests, 1);
  await dialog.waitFor({ state: "hidden" });
  assert.equal(server.store.listNavigation().space.groups[0]?.title, "사슴벌레");
  const groupKey = `g:${server.store.listNavigation().space.groups[0]?.id}`;
  assert.equal(server.store.listNavigation().space.nodes.filter(node => node.parentKey === groupKey).length, 2);
  await page.close();
} finally {
  await browser.close();
  server.stop();
  rmSync(dir, { recursive: true, force: true });
}
