import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import type { NavigationView, SessionSummary } from "../../packages/butler-app/client/ui/src/app/types.ts";
import { LEGACY_FIRST_RUN_STORAGE_KEY as FIRST_RUN_STORAGE_KEY, legacyFirstRunCompleteRecord } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";

const dir = mkdtempSync(join(tmpdir(), "butler-group-drop-"));
const server = await createNativeAppServer({
  butlerData: join(dir, "data"), uiRoot: resolve("packages/butler-app/client/ui/dist"),
});
const navigation = () => server.api<NavigationView>("/navigation");
await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko" }) });
const source = (await server.api<{ session: SessionSummary }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "사죽이 이야기" }) })).session;
const target = (await server.api<{ session: SessionSummary }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "죽랑이 이야기 이어가기" }) })).session;
const browser = await launchSmokeBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  await server.signIn(page);
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: FIRST_RUN_STORAGE_KEY, value: legacyFirstRunCompleteRecord(),
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
  assert.equal((await navigation()).space.groups.length, 0, "drop opens the form before creating a group");
  await dialog.locator("#space-group-title").fill("사슴벌레");
  await dialog.locator('button[type="submit"]').click();
  await dialog.locator('form[aria-busy="true"]').waitFor();
  assert.equal(groupRequests, 1);
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await navigation()).space.groups[0]?.title, "사슴벌레");
  const groupKey = `g:${(await navigation()).space.groups[0]?.id}`;
  assert.equal((await navigation()).space.nodes.filter(node => node.parentKey === groupKey).length, 2);
  await page.close();
} finally {
  await browser.close();
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
