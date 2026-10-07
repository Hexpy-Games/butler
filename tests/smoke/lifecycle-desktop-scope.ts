// Browser contract; no UI unit tests or pixel sampling.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lifecycleBrowser } from "../../packages/butler-app/client/ui/scripts/lifecycle-browser";

const capture = process.argv.includes("--before") ? "before" : "after";
const host = await lifecycleBrowser("/scripts/lifecycle-ds-render.tsx", capture === "before");
const output = resolve(".tmp/lifecycle/ds");
mkdirSync(output, { recursive: true });
try {
  const page = await host.browser.newPage({ reducedMotion: "reduce" });
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${host.url}?setup&theme=${theme}`);
      await page.getByRole("button").waitFor();
      await page.evaluate(() => document.fonts.ready);
      const card = await page.locator('[data-test-class="setup-wizard-content"]').evaluate((element) => {
        const style = getComputedStyle(element);
        return Object.fromEntries(["backgroundColor", "padding", "border", "borderRadius", "boxShadow"].map((key) => [key, style[key as keyof CSSStyleDeclaration]]));
      });
      const baseline = `${output}/before-card-${theme}-${width}.json`;
      if (capture === "before") writeFileSync(baseline, JSON.stringify(card));
      else assert.deepEqual(card, JSON.parse(readFileSync(baseline, "utf8")), "setup solid card preserves its computed appearance");
      await page.screenshot({ path: `${output}/${capture}-setup-${theme}-${width}.png` });
    }
  }
  await page.setViewportSize({ width: 360, height: 264 });
  await page.goto(host.url);
  await page.getByRole("button").waitFor();
  const measured = await page.evaluate(() => ({
    button: document.querySelector("button")!.getBoundingClientRect().height,
    ...Object.fromEntries(["title", "body", "caption"].map((slot) => [slot,
      parseFloat(getComputedStyle(document.querySelector(`[data-slot=${slot}]`)!).fontSize)])),
  }));
  console.log({ capture, measured });
  if (capture !== "before") assert.deepEqual(measured, { button: 28, title: 15, body: 14, caption: 12 });
} finally { await host.close(); }
