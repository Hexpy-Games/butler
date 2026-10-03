// Static lifecycle HTML rendering smoke; Electron behavior is checked separately.
import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { lifecycleWindowHtml } from "../../packages/butler-app/client/electron/lifecycle-window.mjs";
import { getDesktopCopy } from "../../packages/butler-app/client/electron/i18n/desktop-copy.mjs";
import { smokeBrowserArgs } from "../support/smoke-browser-args.ts";

const browser = await chromium.launch({ args: smokeBrowserArgs() });
try {
  const page = await browser.newPage({ viewport: { width: 380, height: 132 } });
  for (const language of ["ko", "en"]) {
    const copy = getDesktopCopy(language);
    const steps = [copy.quitSaving, copy.quitEmbedding, copy.quitStorage, copy.quitConnections, copy.quitServices, copy.quitFinishing];
    for (const status of [...steps.flatMap((step) => [step, `${copy.quitSlow} ${step}`]), copy.quitFailed]) {
      await page.setContent(lifecycleWindowHtml(copy.quitting, status));
      assert.equal(await page.title(), copy.quitting);
      assert.equal(await page.locator("[role=status]").innerText(), status);
      assert.equal(await page.locator("svg circle").getAttribute("r"), "435");
      assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), 132);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 380);
      assert.equal(await page.locator("script").count(), 0);
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).fontSize), "14px");
    }
  }
  if (process.env.BUTLER_QUIT_SCREENSHOT) await page.screenshot({ path: process.env.BUTLER_QUIT_SCREENSHOT });
  console.log("PASS: KO/EN initial, slow and failure copy fits the static DS window");
} finally {
  await browser.close();
}
