// Owner-review matrix through the production settings renderer; no model calls.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser";
import { getAppCopy } from "../../packages/butler-i18n/src";

const uiRoot = resolve("packages/butler-app/client/ui/dist");
const output = resolve(".tmp/update-progress");
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(uiRoot, path === "/" ? "index.html" : path));
  return new Response(await file.exists() ? file : Bun.file(join(uiRoot, "index.html")));
} });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
const stages = ["idle", "checking", "downloading", "verifying", "ready", "applying", "restarting", "failed", "completed"] as const;
const errors: string[] = [];
let cells = 0;
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) for (const locale of ["ko", "en"] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.port}/?visual=update-progress&theme=${theme}&locale=${locale}`);
    const row = page.locator('[data-test-id="update-component-app"]');
    await row.waitFor();
    assert.equal(await page.locator("[data-theme]").first().getAttribute("data-theme"), theme);
    const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US").settings.updateProgress;
    for (const stage of stages) {
      await page.locator(`[data-test-id="stage-${stage}"]`).click();
      const progress = row.locator(`[data-test-id="update-progress"][data-stage="${stage}"]`);
      await progress.waitFor();
      assert((await progress.textContent())?.includes(copy[stage]), stage);
      const update = row.locator("button").first();
      assert.equal(await update.isDisabled(), !["idle", "failed", "completed"].includes(stage), `${stage}: button state`);
      if (stage === "downloading") {
        assert.equal(await progress.getByRole("progressbar").getAttribute("aria-valuenow"), "50");
        assert((await progress.textContent())?.includes("50.0 MB / 100.0 MB"), "complete byte counts");
        await page.locator('[data-test-id="harness-bytes"]').click();
        await progress.getByText(copy.bytesUnavailable, { exact: false }).waitFor();
        assert.equal(await progress.getByRole("progressbar").count(), 0, "no fabricated percentage");
        assert.equal(await progress.locator('[data-slot="spinner"]').count(), 1);
        await page.locator('[data-test-id="harness-navigation"]').click();
        await row.waitFor({ state: "hidden" });
        await page.locator('[data-test-id="stage-verifying"]').click();
        await page.locator('[data-test-id="harness-navigation"]').click();
        await row.locator('[data-stage="verifying"]').waitFor();
        await page.locator('[data-test-id="stage-downloading"]').click();
        await page.locator('[data-test-id="harness-bytes"]').click();
        await row.getByRole("progressbar").waitFor();
      }
      if (stage === "failed") {
        assert((await progress.textContent())?.includes(copy.checksumFailed));
        assert.equal(await update.textContent(), copy.retry);
      }
      if (stage === "applying" || stage === "restarting") assert.equal(await progress.getByRole("progressbar").count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}/${theme}/${locale}/${stage}: no overflow`);
      if (locale === "ko") await page.screenshot({ path: join(output, `${stage}-${width}-${theme}.png`) });
      cells += 1;
    }
    await page.locator('[data-test-id="stage-failed"]').click();
    await row.getByRole("button", { name: copy.retry }).click();
    await row.locator('[data-stage="checking"]').waitFor();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, cells, widths: [375, 1280], themes: ["light", "dark"], locales: ["ko", "en"], navigationRecovery: true, errors: 0 }));
} finally { await browser.close(); server.stop(true); }
