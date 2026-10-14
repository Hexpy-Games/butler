// Offline product UI: shared effort labels in Settings and the composer/menu.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { launchSmokeBrowser, runSmokeCases } from "../support/smoke-browser.ts";

const out = process.env.BUTLER_EFFORT_SHOTS;
if (out) mkdirSync(out, { recursive: true });
const dist = resolve("packages/butler-app/client/ui/dist");
const base = "http://effort-smoke.localhost";
const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };
async function capture(page: Page, name: string) {
  if (!out) return;
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every((animation) =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  await page.screenshot({ path: join(out, name) });
}
if (await runSmokeCases(["ko-light", "ko-dark", "en-light", "en-dark"], "BUTLER_EFFORT_CELL", import.meta.path)) process.exit(0);
const browser = await launchSmokeBrowser();
let cells = 0;
let currentPage: Page | undefined;
try {
  for (const locale of ["ko", "en"] as const) {
    for (const theme of ["light", "dark"] as const) {
      if (process.env.BUTLER_EFFORT_CELL && process.env.BUTLER_EFFORT_CELL !== `${locale}-${theme}`) continue;
      const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US");
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
      currentPage = page;
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== base) return route.abort();
        const path = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
        if (path.startsWith(dist + sep) && existsSync(path)) {
          return route.fulfill({ contentType: types[extname(path)] ?? "text/html", body: readFileSync(path) });
        }
        if (url.pathname.endsWith("/controls")) return route.fulfill({ json: { ok: true, data: {
          session_id: "butler-client", revision: 0, catalog_generation: "harness-model-catalog-v1",
          controls: { model: "openai/gpt-5.6-sol", reasoning_effort: "medium", access_mode: "full_access", plan_mode: false },
        } } });
        return route.fulfill({ json: { ok: true, data: { queued_messages: [] } } });
      });
      await page.goto(`${base}/?visual=components&theme=${theme}&locale=${locale}`);
      await page.waitForFunction((language) => document.documentElement.lang === language, locale === "ko" ? "ko-KR" : "en-US");
      const showSidebar = page.getByRole("button", { name: copy.titlebar.showLeftPanel });
      if (await showSidebar.count()) await showSidebar.first().click();
      await page.locator('[data-test-class="app-sidebar"]').getByRole("button", { name: copy.space.newChat, exact: true }).first().click();
      await page.locator('[data-slot="composer-compact-preview"]').click();
      const chip = page.locator('[data-test-class="model-button"]');
      await chip.waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator('[data-test-class="composer-model-name"]').textContent(), "GPT-5.6 Sol");
      const medium = locale === "ko" ? "보통" : "Medium";
      assert.equal(await page.locator('[data-test-class="composer-model-summary"]').textContent(), medium);
      await capture(page, `after-${locale}-${theme}-composer.png`);
      await chip.click();
      const labels = locale === "ko"
        ? ["없음", "낮음", "보통", "높음", "매우 높음", "최대"]
        : ["None", "Low", "Medium", "High", "Very high", "Max"];
      for (const label of labels) await page.getByText(label, { exact: true }).last().waitFor();
      await capture(page, `after-${locale}-${theme}-menu.png`);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: copy.sidebar.settings, exact: true }).first().click();
      await page.getByText(copy.settings.sections.models, { exact: true }).first().click();
      const select = page.locator('[data-test-class="settings-primary-reasoning-select"]');
      await select.waitFor();
      assert.equal((await select.textContent())?.trim(), medium);
      await select.click();
      for (const label of labels) await page.getByRole("option", { name: label, exact: true }).waitFor();
      await capture(page, `after-${locale}-${theme}-settings.png`);
      assert.deepEqual(errors, []);
      await page.close();
      cells += 1;
    }
  }
  console.log(JSON.stringify({ cells, captures: out ? cells * 3 : 0, modelCalls: 0 }));
} catch (error) {
  if (currentPage) {
    console.error(await currentPage.locator("body").innerText());
    await capture(currentPage, "failure.png");
  }
  throw error;
} finally { await browser.close(); }
