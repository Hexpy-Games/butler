/** Browser smoke of the shipped splash surface and interactive DS owner preview. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { smokeBrowserArgs } from "../support/smoke-browser";

const root = resolve("packages/butler-app/client/ui");
const output = resolve(".tmp/startup-evidence");
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  const site = url.pathname.startsWith("/viewer/");
  const path = site ? url.pathname.slice(8) || "index.html" : url.pathname.slice(1) || "startup.html";
  return new Response(Bun.file(join(root, site ? "dist-ds-site" : "dist", path)));
} });
const browser = await chromium.launch({ channel: "chromium", headless: true, args: smokeBrowserArgs() });
try {
  const page = await browser.newPage({ viewport: { width: 340, height: 280 } });
  await page.addInitScript(() => {
    const target = window as any;
    target.actions = [];
    target.butlerStartup = {
      painted: () => undefined,
      state: async () => ({ stage: "starting", failed: false, language: "ko" }),
      action: async (action: string) => { target.actions.push(action); },
      subscribe: (callback: (value: unknown) => void) => { target.changeStage = callback; return () => undefined; },
    };
  });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto(server.url.href);
    await page.getByRole("status").filter({ hasText: "버틀러를 준비합니다" }).waitFor();
    for (const [stage, label] of [["agent", "에이전트를 시작합니다"], ["migration", "이전 버전을 정리합니다"], ["renderer", "화면을 준비합니다"]]) {
      await page.evaluate((stage) => (window as any).changeStage({ stage, failed: false }), stage);
      await page.getByRole("status").filter({ hasText: label }).waitFor();
    }
    await page.screenshot({ path: join(output, `${colorScheme}.png`) });
    await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
    await page.evaluate(() => (window as any).changeStage({ stage: "renderer", failed: false, reducedMotion: true }));
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#mark")!).animationName === "none");
    await page.evaluate(() => (window as any).changeStage({ stage: "renderer", failed: false, reducedMotion: false }));
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#mark")!).animationName === "none");
    await page.evaluate(() => (window as any).changeStage({ stage: "agent", failed: true }));
    await page.getByRole("alert").waitFor();
    await page.getByRole("button", { name: "다시 시도" }).click();
    await page.getByRole("button", { name: "로그 보기" }).click();
    assert.deepEqual(await page.evaluate(() => (window as any).actions), ["retry", "logs"]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(output, `${colorScheme}-error.png`) });
  }
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(new URL("viewer/?page=patterns/startup&theme=dark&locale=ko&motion=reduced", server.url).href);
  await page.locator("[data-ds-pattern=startup]").waitFor();
  await page.getByRole("button", { name: "시작하지 못했습니다." }).click();
  const preview = page.frameLocator('iframe[title="시작 화면"]');
  await preview.getByRole("button", { name: "로그 보기" }).click();
  await page.getByRole("status").filter({ hasText: "진단 로그를 내보냈습니다." }).waitFor();
  await preview.getByRole("button", { name: "다시 시도" }).click();
  await preview.getByRole("status").filter({ hasText: "버틀러를 준비합니다" }).waitFor();
  const options = await page.getByRole("combobox", { name: "배경", exact: true }).locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  assert.equal(options.length, 11, "every built-in wallpaper plus none");
  for (const value of options) {
    await page.getByRole("combobox", { name: "배경", exact: true }).selectOption(value);
    await preview.locator("html[data-painted=true]").waitFor();
    assert.ok(await preview.locator("#wallpaper").evaluate((image) => (image as HTMLImageElement).naturalWidth > 0));
  }
  await page.screenshot({ path: join(output, "viewer.png") });
  console.log("PASS startup stages, retry/log actions, light/dark, reduced motion, no overflow, DS preview");
} finally { await browser.close(); server.stop(true); }
