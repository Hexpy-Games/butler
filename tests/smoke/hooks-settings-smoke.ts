// UI behavior through the actual Settings screen; command handlers are mocked here.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser";
import { getAppCopy } from "../../packages/butler-i18n/src";
const output = process.env.HOOK_SCREENSHOTS ?? "/tmp/butler-hooks-screenshots";
mkdirSync(output, { recursive: true });
const root = process.env.HOOK_UI_ROOT ?? resolve("packages/butler-app/client/ui/dist");
const baseline = process.env.HOOK_BASELINE === "1";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const file = Bun.file(join(root, new URL(request.url).pathname));
  return new Response(await file.exists() ? file : Bun.file(join(root, "index.html")));
} });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  for (const width of [1280, 375]) for (const theme of ["light", "dark"]) for (const locale of ["en", "ko"]) {
    const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US");
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    let hooks: unknown[] = [], revision = 0;
    const runs: unknown[] = [];
    await page.route("**/hooks**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === "PUT") { hooks = request.postDataJSON().config.hooks; revision += 1; }
      if (path.endsWith("/test")) runs.push({ time: "2026-10-06T09:00:00Z", hook_id: "test", event: "UserPromptSubmit", session_id: null,
        outcome: "continue", duration_ms: 4, exit_code: 0, stdout: "test output", stderr: "" });
      await route.fulfill({ json: { data: path.endsWith("/runs") ? runs : path.endsWith("/test") ? runs.at(-1) : { revision, config: { version: 1, hooks }, error: null } } });
    });
    await page.goto(`http://127.0.0.1:${server.port}/?visual=components&locale=${locale}&theme=${theme}`);
    await page.locator('[data-test-class~="visual-harness"]').waitFor();
    if (width === 375) await page.getByRole("button", { name: copy.titlebar.hideRightPanel, exact: true }).first().click();
    const showSidebar = page.getByRole("button", { name: copy.titlebar.showLeftPanel, exact: true });
    if (await showSidebar.isVisible()) await showSidebar.click();

    await page.getByRole("button", { name: copy.sidebar.settings, exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(output, `settings-${width}-${theme}-${locale}.png`) });
    if (!baseline) {
      await page.getByRole("button", { name: copy.settings.sections.hooks, exact: true }).click();
      await page.getByRole("button", { name: copy.settings.hooks.add, exact: true }).click();
      await page.locator("#hook-name").fill("Test guard");
      await page.locator("#hook-command").fill("printf okay");
      await page.screenshot({ path: join(output, `form-${width}-${theme}-${locale}.png`), fullPage: true });
      await page.getByRole("button", { name: copy.common.save, exact: true }).click();
      await page.getByText("Test guard", { exact: true }).waitFor();
      assert.equal(hooks.length, 1);
      await page.getByRole("button", { name: copy.settings.hooks.edit, exact: true }).click();
      await page.locator("#hook-name").fill("Edited guard");
      await page.getByRole("button", { name: copy.common.save, exact: true }).click();
      await page.getByText("Edited guard", { exact: true }).waitFor();
      await page.getByRole("button", { name: copy.settings.hooks.test, exact: true }).click();
      await page.getByRole("button", { name: /test · UserPromptSubmit · continue/u }).click();
      assert.equal(await page.getByRole("textbox", { name: "test", exact: true }).inputValue(), "test output");
      assert.equal(runs.length, 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(output, `hooks-${width}-${theme}-${locale}.png`), fullPage: true });
      await page.getByRole("button", { name: copy.settings.hooks.remove, exact: true }).click();
      await page.getByText("Edited guard", { exact: true }).waitFor({ state: "hidden" });
      assert.equal(hooks.length, 0);
    }
    await page.close();
  }
  console.log(`Hooks Settings: ${baseline ? "baseline" : "CRUD/test/log"}, 8 viewport/theme/language combinations passed; ${output}`);
} finally { await browser.close(); server.stop(true); }
