import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { FIRST_RUN_STORAGE_KEY, firstRunCompleteState } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { readFirstChatOnboardingState, writeFirstChatOnboardingState } from "../../packages/butler-agent/src/personalization/onboarding.ts";

// Real settings controls and HTTP state, without a provider or production data.
const dir = mkdtempSync(join(tmpdir(), "butler-locale-switch-"));
writeFirstChatOnboardingState(dir, { ...readFirstChatOnboardingState(dir), status: "complete", completed_at: new Date().toISOString() });
const server = createTestAppServer({ butlerData: dir, dbPath: join(dir, "app.sqlite"),
  uiRoot: resolve("packages/butler-app/client/ui/dist"), port: 0 });
server.store.updateSettings({ language: "ko" });
server.store.updatePersonalization({ response_language: "ko" });
server.store.createSession({ kind: "chat", title: "사용자 제목은 번역하지 않습니다" });
const browser = await chromium.launch({ headless: true });
const output = resolve(".tmp/sidebar-r7");
mkdirSync(output, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: FIRST_RUN_STORAGE_KEY, value: firstRunCompleteState("ko") });
  await page.goto(server.url);
  let current = getAppCopy("ko-KR");
  const sidebar = page.locator('[data-test-class="app-sidebar"]');
  await page.locator("[data-left-open]").waitFor();
  if (await page.locator("[data-left-open]").getAttribute("data-left-open") === "false") {
    await page.locator('[data-test-class="chrome-floating-toggle-layer"] button').click();
  }
  await sidebar.getByRole("button", { name: current.space.general, exact: true }).click();
  const draft = "전환 중에도 이 입력은 보존되어야 합니다";
  await page.getByRole("textbox", { name: "메시지 입력", exact: true }).fill(draft);
  for (const language of ["en", "ko"] as const) {
    await sidebar.getByRole("button", { name: current.sidebar.settings, exact: true }).click();
    await page.getByRole("combobox", { name: current.settings.fields.language, exact: true }).click();
    await page.getByRole("option", { name: language === "en" ? current.settings.options.english : current.settings.options.korean, exact: true }).click();
    current = getAppCopy(language === "ko" ? "ko-KR" : "en-US");
    await page.getByRole("combobox", { name: current.settings.fields.language, exact: true }).waitFor();
    await page.locator('[data-test-class~="settings-header"] [role="button"]').click();
    await sidebar.getByRole("button", { name: current.space.general, exact: true }).waitFor();
    await sidebar.getByRole("tab").nth(1).click();
    await sidebar.getByText("사용자 제목은 번역하지 않습니다", { exact: true }).waitFor();
    const general = sidebar.locator('[data-test-class="tree-row"]').filter({ hasText: current.space.general }).first();
    await general.locator('[data-slot="nav-row-meta"]').getByText(current.space.general, { exact: true }).waitFor();
    assert.equal(server.store.getSettings().language, language);
    assert.equal(server.store.getPersonalization().response_language, "ko");
    assert.equal(await page.getByRole("textbox").first().innerText(), draft);
    await page.screenshot({ path: join(output, `locale-${language}.png`) });
    console.log(`PASS settings ${language}: sidebar cache, authored title, draft and response-language independence`);
  }
} finally {
  await browser.close();
  server.stop();
}
