/** Interactive shipped lifecycle page: stage updates, reduced motion and actions. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser-args";

const directory = resolve("packages/butler-app/client/ui/lifecycle-assets");
const copy = JSON.parse(readFileSync(join(directory, "copy.json"), "utf8"));
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 264 } });
  await page.addInitScript((copy) => {
    Object.assign(window, { actions: [], butlerLifecycle: {
      state: async () => ({ kind: "startup", stage: "prepare", theme: new URLSearchParams(location.search).get("theme"), locale: "ko", copy }),
      onState() {}, painted() {}, action: (action: string) => (window as any).actions.push(action),
    } });
  }, copy);
  for (const theme of ["light", "dark"]) {
    await page.goto(`${pathToFileURL(join(directory, "lifecycle.html"))}?theme=${theme}`);
    await page.locator("html[data-painted=true]").waitFor();
    for (const stage of ["prepare", "service", "screen", "upgrade", "data"]) {
      await page.evaluate((stage) => (window as any).lifecycleState({ stage }), stage);
      assert.equal(await page.locator('[data-slot="line"]').textContent(), copy.ko.startup.stage[stage]);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => (window as any).lifecycleState({ reducedMotion: true }));
    assert.equal(await page.locator('[data-slot="mark"]').getAttribute("data-breathe"), "on");
    await page.evaluate(() => (window as any).lifecycleState({ state: "error", failedStage: "service" }));
    await page.getByRole("alert").waitFor();
    assert.equal(await page.locator('[data-slot="primary"]').evaluate((button) => document.activeElement === button), true);
    await page.getByRole("button", { name: copy.ko.action.retry }).click();
    await page.getByRole("button", { name: copy.ko.action.openLog }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).actions), ["retry", "log"]);
    assert.equal(await page.locator('[data-slot="mark"]').getAttribute("data-breathe"), "");
  }
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname.slice(1) || "index.html";
    return new Response(Bun.file(join(resolve("packages/butler-app/client/ui/dist-ds-site"), path)));
  } });
  try {
    const previewPage = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await previewPage.goto(new URL("?page=patterns/startup&theme=dark&locale=ko&motion=reduced", server.url).href);
    await previewPage.locator("[data-ds-pattern=startup]").waitFor();
    await previewPage.getByRole("button", { name: "시작하지 못했습니다." }).click();
    const preview = previewPage.frameLocator('iframe[title="시작 화면"]');
    await preview.getByRole("button", { name: copy.ko.action.openLog }).click();
    await previewPage.getByRole("status").filter({ hasText: "진단 로그를 내보냈습니다." }).waitFor();
    await preview.getByRole("button", { name: copy.ko.action.retry }).click();
    await preview.getByRole("status").filter({ hasText: copy.ko.startup.stage.prepare }).waitFor();
    const picker = previewPage.getByRole("combobox", { name: "배경", exact: true });
    const options = await picker.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    assert.equal(options.length, 11, "all standalone built-ins plus none");
    for (const value of options) {
      await picker.selectOption(value);
      await preview.locator("html[data-painted=true]").waitFor();
      if (value === "none") assert.equal(await preview.locator("img").count(), 0);
      else assert.ok(await preview.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth > 0));
    }
  } finally { server.stop(true); }
  console.log("PASS startup stages, themes, reduced motion, error focus, actions and DS preview");

} finally { await browser.close(); }
