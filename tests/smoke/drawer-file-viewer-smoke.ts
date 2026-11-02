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
    await closeViewer(page);
    for (const item of [...drawerFiles.slice(1), drawerDoc, drawerOutput]) {
      if (item === drawerOutput) await page.locator('[data-test-class="library-entry"]').click();
      await page.locator(`[data-library-item="${item.id}"]`).getByText(item.title, { exact: true }).click();
      await viewer.waitFor();
      if (item === drawerDoc) await viewer.getByText("세션에서 작성한 본문입니다.", { exact: true }).waitFor();
      else if (item === drawerOutput || item.title.endsWith(".html")) await viewer.locator("iframe").waitFor();
      else if (item.title.endsWith(".pdf")) await viewer.locator('[data-preview-mode="pdf"] iframe').waitFor();
      else await viewer.locator("img").evaluate((node: HTMLImageElement) => node.decode());
      await assertDrawer(page);
      await assertReadingWidth(page, item === drawerDoc);
      if (item === drawerDoc) assert((await viewer.locator('[role="tab"]').count()) > 1, "closing also returns from a multi-file viewer");
      await capture(page, item.id);
      if (item === drawerOutput) {
        await viewer.getByRole("button", { name: "브라우저에서 열기", exact: true }).click();
        const owners = await page.evaluate(() => (window as Window & { __browserCalls?: { method: string; input?: { owner?: string } }[] })
          .__browserCalls?.filter((call) => call.method === "create").map((call) => call.input?.owner));
        assert.deepEqual(owners, [`conversation:${DRAWER_SESSION}`], "page browser action uses its source session, not the previously active chat");
      }
      await closeViewer(page);
    }
    for (const width of [1000, 1800, 2200, 768, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.locator(`[data-library-item="${drawerFiles[0]!.id}"]`).getByText(drawerFiles[0]!.title, { exact: true }).click();
      await viewer.locator("h1").waitFor();
      await page.waitForFunction(() => {
        for (let node = document.querySelector('[data-test-class="file-viewer"]'); node; node = node.parentElement) {
          if (node.getAnimations().some((animation) => animation.playState === "running")) return false;
        }
        return true;
      });
      const focus = await auditTabOrder(page, { within: '[data-test-class="file-viewer"]', maxStops: 12 });
      assert(focus.stops > 0);
      assert.deepEqual(focus.clipped, [], "drawer viewer focus rings stay inside clipping ancestors");
      const geometry = await viewer.boundingBox();
      assert(geometry && geometry.x >= -0.5 && geometry.x + geometry.width <= width + 0.5, JSON.stringify({ width, geometry }));
      await assertDrawer(page);
      await assertReadingWidth(page, true);
      await capture(page, `viewer-over-drawer-${width}`);
      await closeViewer(page);
      if (width >= 1800) {
        await openDrawer(page);
        await page.locator(`[data-library-item="${drawerDoc.id}"]`).getByText(drawerDoc.title, { exact: true }).click();
        await viewer.getByText("세션에서 작성한 본문입니다.", { exact: true }).waitFor();
        await assertReadingWidth(page, true);
        await capture(page, `editable-document-${width}`);
        await closeViewer(page);
      }
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await openDrawer(page);
    await page.setViewportSize({ width: 390, height: 480 });
    const scroller = page.locator('[data-test-class="library-page"]');
    await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; node.setAttribute("data-scroll-probe", "retained"); });
    const documentCard = page.locator(`[data-library-item="${drawerDoc.id}"]`).getByText(drawerDoc.title, { exact: true });
    await documentCard.scrollIntoViewIfNeeded();
    await scroller.evaluate((node) => node.addEventListener("click", () => {
      node.setAttribute("data-open-scroll", String(node.scrollTop));
    }, { once: true, capture: true }));
    await documentCard.click();
    const scrollTop = Number(await scroller.getAttribute("data-open-scroll"));
    await viewer.getByText("세션에서 작성한 본문입니다.", { exact: true }).waitFor();
    assert(scrollTop > 0, "exercise a scrolled drawer");
    await assertReadingWidth(page, true);
    await capture(page, "editable-document-scrolled");
    await closeViewer(page);
    assert.equal(await scroller.getAttribute("data-scroll-probe"), "retained", "same drawer DOM");
    assert.equal(await scroller.evaluate((node) => node.scrollTop), scrollTop, "same drawer scroll position");
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
  assert.equal(await page.locator('[data-test-class="file-viewer-open-in-library"]').count(), 0, "already in the drawer");
  const region = (await page.locator('[data-test-class="library-region"]').boundingBox())!;
  const viewer = (await page.locator('[data-test-class="file-viewer"]').boundingBox())!;
  assert(viewer.x >= region.x && viewer.y >= region.y && viewer.x + viewer.width <= region.x + region.width + 1
    && viewer.y + viewer.height <= region.y + region.height + 1, "viewer stays inside drawer region");
  const sidebar = await page.locator('[data-test-class="app-sidebar"]').boundingBox();
  if (sidebar && sidebar.x >= 0 && sidebar.x + sidebar.width <= region.x)
    assert(viewer.x >= sidebar.x + sidebar.width, "viewer leaves sidebar uncovered");
  assert.equal(await page.locator('[data-test-class~="conversation"]').count(), 0, "does not switch to a session");
}
async function capture(page: Page, name: string) {
  if (shots) await page.screenshot({ path: join(shots, `${before ? "before" : "after"}-${theme}-${name}.png`), animations: "disabled" });
}

async function closeViewer(page: Page) {
  const viewer = page.locator('[data-test-class="file-viewer"]');
  await viewer.locator('[data-test-class="file-viewer-close"]').click();
  await viewer.waitFor({ state: "hidden" });
  await page.locator('[data-test-class="library-page"]').waitFor({ state: "visible" });
}
async function assertReadingWidth(page: Page, fill: boolean) {
  const geometry = await page.locator('[data-test-class="file-viewer"]').evaluate((viewer) => {
    const frame = viewer.querySelector('[data-test-class="file-viewer-page"]')!.getBoundingClientRect();
    const content = viewer.querySelector('[data-test-class="artifact-viewer"], [data-test-class="editable-document"]')!.getBoundingClientRect();
    return { pane: viewer.clientWidth, page: frame.width, content: content.width,
      center: content.x + content.width / 2 - (frame.x + frame.width / 2) };
  });
  const expected = Math.min(fill ? 1400 : 760, geometry.pane) - 96;
  assert(Math.abs(geometry.content - expected) <= 1, `reading width: ${JSON.stringify(geometry)}, expected ${expected}`);
  assert(Math.abs(geometry.center) <= 1, "reading content stays centered");
  console.log(JSON.stringify({ theme, width: page.viewportSize()!.width, fill, ...geometry }));
}
