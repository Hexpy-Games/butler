import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { webkit, devices } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";

const root = mkdtempSync(join(tmpdir(), "butler-diff-mobile-"));
const output = resolve(".tmp/changed-line-diff-mobile");
mkdirSync(output, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const browser = await webkit.launch({ headless: true });
try {
  for (const width of [375, 430]) {
    const page = await browser.newPage({ ...devices["iPhone 13"], viewport: { width, height: 844 } });
    await server.signIn(page);
    try {
      await page.goto(`${server.url}?visual=design-system&page=blocks/ChangedLineDiff`, { waitUntil: "networkidle" });
      await page.locator('[data-ds-detail="ChangedLineDiff"]').waitFor({ state: "visible" });
      const region = page.locator('[data-ds-story="Standalone"] #ds-diff').first();
      await region.scrollIntoViewIfNeeded();
      const metrics = await region.evaluate((element) => {
        const rows = [...element.querySelectorAll<HTMLElement>("[data-line-type]")];
        return {
          viewportWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          codeFontSize: getComputedStyle(element).getPropertyValue("--font-size-2").trim(),
          widths: rows.map((row) => row.getBoundingClientRect().width),
          codeLefts: rows.map((row) => row.querySelector("code")!.getBoundingClientRect().left),
          fonts: rows.map((row) => getComputedStyle(row.querySelector("code")!).fontSize),
          heights: rows.map((row) => row.getBoundingClientRect().height),
          whitespace: rows.map((row) => getComputedStyle(row.querySelector("code")!).whiteSpace),
        };
      });
      assert(metrics.scrollWidth > metrics.viewportWidth, "long lines scroll horizontally");
      assert.equal(new Set(metrics.widths).size, 1, "every background spans the same width");
      assert.equal(new Set(metrics.codeLefts).size, 1, "line-number columns align");
      assert.deepEqual([...new Set(metrics.fonts)], [metrics.codeFontSize], "every line uses the DS code size");
      assert.equal(new Set(metrics.heights).size, 1, "blank and nonblank rows have the same height");
      assert.deepEqual([...new Set(metrics.whitespace)], ["pre"]);
      await region.screenshot({ path: join(output, `${width}-start.png`), animations: "disabled" });
      await page.screenshot({ path: join(output, `${width}-page.png`) });
      await region.evaluate((element) => { element.scrollLeft = 180; });
      assert(await region.evaluate((element) => element.scrollLeft > 0));
      await region.screenshot({ path: join(output, `${width}-scrolled.png`), animations: "disabled" });
      console.log(`WebKit ${width}px: aligned rows, uniform ${metrics.codeFontSize} code, horizontal scroll PASS`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.stop();
  rmSync(root, { recursive: true, force: true });
}
