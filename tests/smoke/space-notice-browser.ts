import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { FIRST_RUN_STORAGE_KEY, firstRunCompleteState } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";
import { readFirstChatOnboardingState, writeFirstChatOnboardingState } from "../../packages/butler-agent/src/personalization/onboarding.ts";

// Isolated HTTP/store + real product UI. No provider calls or production mutations.
const dir = mkdtempSync(join(tmpdir(), "butler-space-notice-"));
writeFirstChatOnboardingState(dir, { ...readFirstChatOnboardingState(dir), status: "complete", completed_at: new Date().toISOString() });
const output = resolve(".tmp/space-notice");
mkdirSync(output, { recursive: true });
const server = createTestAppServer({ butlerData: dir, dbPath: join(dir, "app.sqlite"),
  uiRoot: resolve("packages/butler-app/client/ui/dist"), port: 0 });
server.store.updateSettings({ language: "ko" });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
      { key: FIRST_RUN_STORAGE_KEY, value: firstRunCompleteState("ko") });
    await page.goto(server.url);
    await page.locator("[data-panel-layout]").waitFor();
    const show = page.getByRole("button", { name: "사이드바 보기", exact: true });
    if (await show.isVisible()) await show.click();
    const sidebar = page.locator('[aria-label="스페이스 탐색"]');
    const settings = sidebar.getByRole("button", { name: "설정", exact: true });
    await settings.waitFor();
    const before = await settings.boundingBox();
    await sidebar.getByRole("button", { name: "그룹 만들기", exact: true }).click();
    await page.getByLabel("그룹 이름", { exact: true }).fill(`토스트 검증 ${width}`);
    const createdResponse = page.waitForResponse(response => response.url().endsWith("/space/groups") && response.request().method() === "POST");
    await page.getByRole("button", { name: "저장", exact: true }).click();
    const created = (await (await createdResponse).json()).data;
    await sidebar.getByText(`토스트 검증 ${width}`, { exact: true }).waitFor();
    assert.equal(await page.locator('[data-sonner-toast]:not([data-removed="true"])').count(), 0);
    assert.equal((await settings.boundingBox())?.y, before?.y);
    // Fixture only the automatic-origin projection. Preserve the real revision/token so
    // Sonner's action still exercises the actual HTTP undo, not a mocked UI callback.
    await page.route("**/navigation", async route => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.data.space.revision === created.space.revision) {
        body.data.space.smartNotice = { title: "식혜", revision: created.space.revision, undoToken: created.undoToken };
      }
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await page.locator("[data-panel-layout]").waitFor();
    if (await show.isVisible()) await show.click();
    await settings.waitFor();
    const notice = page.locator("[data-sonner-toast]").filter({ hasText: "식혜 그룹으로 정리했습니다." });
    await notice.waitFor();
    const undo = notice.getByRole("button", { name: "목록 변경 되돌리기", exact: true });
    await undo.waitFor();
    await notice.hover(); // Pause Sonner's timer while capturing its actual UI.
    assert.equal(await sidebar.getByText("목록 변경 되돌리기", { exact: true }).count(), 0);
    assert.equal((await settings.boundingBox())?.y, before?.y);
    const rect = (await notice.boundingBox())!;
    assert(rect.x >= 0 && rect.x + rect.width <= width);
    assert(server.store.listNavigation().space.groups.some(group => group.title === `토스트 검증 ${width}`));
    await page.screenshot({ path: join(output, `toast-${width}.png`) });
    await undo.click();
    await page.waitForFunction(() => !document.querySelector('[data-sonner-toast]:not([data-removed="true"])'));
    assert(!server.store.listNavigation().space.groups.some(group => group.title === `토스트 검증 ${width}`));
    console.log(`PASS ${width}: manual creation silent; automatic notice outside sidebar, stable footer, actual HTTP undo`);
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
} finally {
  await browser.close();
  server.stop();
}
