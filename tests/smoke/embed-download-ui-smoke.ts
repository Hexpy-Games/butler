// Browser smoke: optional progress never gates consent/connection; Settings retry stays ready.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { onboardingCompletedPatch } from "../../packages/butler-app/client/ui/src/app/onboarding.ts";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import { firstRunCopy } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";

const output = resolve(".tmp/embed-download-ui");
mkdirSync(output, { recursive: true });

async function capture(page: Page, language: string, screen: string, row?: Locator) {
  for (const width of [320, 375, 390, 430, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if (row && !(await row.isVisible())) {
      await page.getByRole("button", { name: language === "ko" ? "일반" : "General", exact: true }).click();
    }
    if (row) await row.scrollIntoViewIfNeeded();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) throw new Error(`${screen} overflows at ${width}`);
    await page.screenshot({ path: `${output}/${screen}-${language}-${width}.png` });
  }
}

const browser = await chromium.launch({ headless: true });
try {
  for (const language of ["ko", "en"] as const) {
    const server = await createNativeAppServer({ onboardingComplete: false, config: { language } });
    try {
      setAppCopyLanguage(language);
      const context = await browser.newContext({ locale: language });
      const page = await context.newPage();
      await server.signIn(page);
      let state = "downloading";
      let retried = false;
      const model = () => ({ state, bytes_done: 312_000_000, bytes_total: 570_000_000, reason: state === "failed" ? "embed_asset_download_failed" : undefined });
      await page.route("**/setup/readiness", async (route) => {
        await route.fulfill({ json: { protocol_version: "butler.app.v1", data: { status: "ready", steps: [], memory_model: model() } } });
      });
      await page.route("**/setup/readiness/retry", async (route) => {
        if (route.request().postDataJSON().memory_model_only !== true) throw new Error("Model retry must preserve setup readiness");
        retried = true;
        state = "downloading";
        await route.fulfill({ json: { ok: true, data: { status: "ready", steps: [], memory_model: model() } } });
      });
      await page.goto(server.url);
      const row = page.locator('[data-test-class="memory-model-status"]');
      await row.waitFor();
      if (!(await row.innerText()).includes("54% · 312 / 570 MB")) throw new Error("Missing progress size");
      await capture(page, language, "welcome");
      const agree = page.getByRole("button", { name: firstRunCopy[language].agree, exact: true });
      if (!(await agree.isEnabled())) throw new Error("Download blocked consent");
      await agree.click();
      await row.waitFor();
      await page.screenshot({ path: `${output}/connection-${language}.png` });
      // Complete onboarding through the real public settings path, then inspect Settings.
      const now = new Date().toISOString();
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ ...onboardingCompletedPatch({}, now, now), language }) });
      await page.reload();
      await page.getByRole("button", { name: appCopy.sidebar.settings, exact: true }).click();
      await row.waitFor();
      await capture(page, language, "settings", row);
      state = "failed";
      await row.getByText(language === "ko" ? "메모리 모델 다운로드 실패" : "Memory model download failed").waitFor();
      await capture(page, language, "failed", row);
      await page.getByRole("button", { name: language === "ko" ? "다시 시도" : "Retry", exact: true }).click();
      if (!retried) throw new Error("Retry was not sent");
      await row.getByText(language === "ko" ? "메모리 모델 받는 중" : "Downloading memory model").waitFor();
      state = "ready";
      await row.waitFor({ state: "hidden" });
      await context.close();
    } finally {
      await server.stop();
    }
  }
  console.log("PASS: ko/en progress at 320/375/390/430/1440px; consent, connection, Settings retry and ready");
} finally {
  await browser.close();
}
