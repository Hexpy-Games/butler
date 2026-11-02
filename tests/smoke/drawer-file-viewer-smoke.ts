// test-category: race
// Real library click/menu handlers and shared viewer, offline gateway; no native agent or model calls.
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { auditTabOrder } from "../support/focus-ring-clipping";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { installSessionBrowser } from "../support/session-info-fixtures";
import { DRAWER_SESSION, drawerDoc, drawerFiles, drawerOutput, installDrawerGateway } from "../support/drawer-viewer-fixtures";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser";

const cases = ["light", "dark"];
if (await runSmokeCases(cases, "BUTLER_DRAWER_CASE", import.meta.path, { isolate: true })) process.exit(0);
const theme = process.env.BUTLER_DRAWER_CASE!;
const before = process.argv.includes("--capture-before");
const shots = process.env.BUTLER_SMOKE_SCREENSHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const browser = await launchSmokeBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const base = "http://drawer.localhost";
  await installSessionBrowser(page);
  await installDrawerGateway(page, resolve("packages/butler-app/client/ui/dist"), base);
  await page.goto(`${base}/?visual=components&theme=${theme}&locale=ko`);
  await page.locator('[data-test-class~="conversation"]').waitFor();
  const sidebar = page.getByRole("button", { name: "사이드바 보기", exact: true });
  if (await sidebar.count()) await sidebar.click();
  await openDrawer(page);
  await capture(page, "drawer");
  await page.locator(`[data-library-item="${drawerFiles[0]!.id}"]`).getByText(drawerFiles[0]!.title, { exact: true }).click();
  const viewer = page.locator('[data-test-class="file-viewer"]');
  if (before) {
    await page.locator('[data-test-class~="conversation"]').waitFor();
    await viewer.waitFor();
    assert.equal(await page.locator('[data-test-class="library-page"]').count(), 0, "baseline leaves the drawer");
    await capture(page, "navigates-away");
  } else {
    await viewer.locator("h1").getByText("릴리스 노트", { exact: true }).waitFor();
    await assertDrawer(page);
    await capture(page, "viewer-over-drawer");
    await viewer.locator('[data-test-class="file-viewer-open-in-library"]').click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await page.locator('[data-test-class="library-toolbar"] input').inputValue(), drawerFiles[0]!.title);
    await page.locator('[data-test-class="library-toolbar"] input').fill("");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    for (const item of [...drawerFiles.slice(1), drawerDoc, drawerOutput]) {
      if (item === drawerOutput) await page.locator('[data-test-class="library-entry"]').click();
      await page.locator(`[data-library-item="${item.id}"]`).getByText(item.title, { exact: true }).click();
      await viewer.waitFor();
      if (item === drawerDoc) await viewer.getByText("세션에서 작성한 본문입니다.", { exact: true }).waitFor();
      else if (item === drawerOutput || item.title.endsWith(".html")) await viewer.locator("iframe").waitFor();
      else if (item.title.endsWith(".pdf")) await viewer.locator('[data-preview-mode="pdf"] iframe').waitFor();
      else await viewer.locator("img").evaluate((node: HTMLImageElement) => node.decode());
      await assertDrawer(page);
      await capture(page, item.id);
      if (item === drawerOutput) {
        await viewer.getByRole("button", { name: "브라우저에서 열기", exact: true }).click();
        const owners = await page.evaluate(() => (window as Window & { __browserCalls?: { method: string; input?: { owner?: string } }[] })
          .__browserCalls?.filter((call) => call.method === "create").map((call) => call.input?.owner));
        assert.deepEqual(owners, [`conversation:${DRAWER_SESSION}`], "page browser action uses its source session, not the previously active chat");
      }
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.locator(`[data-library-item="${drawerFiles[0]!.id}"]`).getByText(drawerFiles[0]!.title, { exact: true }).click();
      await viewer.locator("h1").waitFor();
      const focus = await auditTabOrder(page, { within: '[data-test-class="library-file-viewer"]', maxStops: 12 });
      assert(focus.stops > 0);
      assert.deepEqual(focus.clipped, [], "drawer viewer focus rings stay inside clipping ancestors");
      const geometry = await viewer.boundingBox();
      assert(geometry && geometry.x >= 0 && geometry.x + geometry.width <= width);
      await assertDrawer(page);
      await capture(page, `responsive-${width}`);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    for (const item of [...drawerFiles, drawerDoc, drawerOutput]) {
      if (item === drawerOutput) await page.locator('[data-test-class="library-entry"]').click();
      const card = page.locator(`[data-library-item="${item.id}"]`);
      await card.getByRole("button", { name: "더 보기", exact: true }).click();
      await page.getByRole("menuitem", { name: "대화로 이동", exact: true }).waitFor();
      if (item === drawerFiles[0]) await capture(page, "secondary-menu");
      await page.getByRole("menuitem", { name: "대화로 이동", exact: true }).click();
      assert.equal(await page.locator('[data-test-class="titlebar-title"]').innerText(), getAppCopy("ko-KR").space.general);
      await page.locator('[data-test-class~="conversation"]').waitFor();
      assert.equal(await page.locator('[data-test-class="library-page"]').count(), 0);
      if (item === drawerFiles[0]) await capture(page, "secondary-conversation");
      await openDrawer(page);
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: "PASS", theme, before, fileKinds: before ? 1 : 6, deviceScaleFactor: 2 }));
} finally { await browser.close(); }

async function openDrawer(page: Page) {
  await page.locator('[data-test-class="library-entry"]').click();
  await page.locator(`[data-library-item="${drawerFiles[0]!.id}"]`).waitFor();
  // Kind view lists all documents rather than the main screen's latest row.
  await page.locator('[data-library-kind="document"]').getByRole("button", { name: "모두 보기", exact: true }).click();
  await page.locator(`[data-library-item="${drawerDoc.id}"]`).waitFor();
}
async function assertDrawer(page: Page) {
  assert.equal(await page.locator('[data-test-class="library-page"]').count(), 1, "drawer stays mounted");
  assert.equal(await page.locator('[data-test-class~="conversation"]').count(), 0, "does not switch to a session");
}
async function capture(page: Page, name: string) {
  if (shots) await page.screenshot({ path: join(shots, `${before ? "before" : "after"}-${theme}-${name}.png`), animations: "disabled" });
}
