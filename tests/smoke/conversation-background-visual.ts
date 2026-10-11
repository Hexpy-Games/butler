// test-category: race
// Before/after product captures through the isolated native stub gateway.
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";

const stage = process.env.BUTLER_BACKGROUND_STAGE ?? "after";
assert(stage === "before" || stage === "after");
const out = process.env.BUTLER_SMOKE_SCREENSHOTS;
assert(out, "Explicit temporary screenshot destination required");
mkdirSync(out, { recursive: true });
const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist"),
  stubReply: () => Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}: Synthetic conversation for layout verification.`).join("\n\n") });
const browser = await launchSmokeBrowser();
const shots: string[] = [];
const source = (kind: string) => kind === "none" ? { kind: "none" } : { kind: "live", module: `butler.${kind}` };
async function capture(page: Page, screen: string, width: number, theme: string, kind: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No horizontal overflow");
  const path = join(out!, `${stage}-${screen}-${width}-${theme}-${kind}.png`);
  await page.screenshot({ path }); shots.push(path);
}
async function appearance(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").fill("모양");
  await dialog.getByRole("option").filter({ hasText: "모양" }).click();
  await page.locator('[data-test-class~="settings-main-screen-wallpaper-picker"]').waitFor();
}
async function settings(page: Page, width: number, theme: string, kind: string) {
  await appearance(page);
  await capture(page, "settings-home", width, theme, kind);
  const target = stage === "after" ? '[data-settings-section-id="conversation"]' : '[data-settings-section-id="message-box"]';
  await page.locator(target).scrollIntoViewIfNeeded();
  await capture(page, "settings-conversation", width, theme, kind);
  await page.locator('[data-settings-section-id="message-box"]').scrollIntoViewIfNeeded();
  await capture(page, "settings-message-box", width, theme, kind);
}
try {
  const page = await browser.newPage({ reducedMotion: "reduce" }); await server.signIn(page);
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) for (const kind of ["riso-print", "none"]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
      wallpaper: { source: source(kind) }, conversation_background: { source: source(kind), overlay: 70 } }) });
    await page.goto(server.url); await page.locator('[data-test-class~="new-chat-empty-state"]').waitFor();
    await capture(page, "newchat", width, theme, kind);
    await settings(page, width, theme, kind);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.url);
  const preview = page.locator('[data-slot="composer-compact-preview"]');
  if (await preview.isVisible()) await preview.click();
  await page.locator('[data-test-class~="composer-card"] [contenteditable="true"]').fill("Create a synthetic layout conversation.");
  await page.getByRole("button", { name: "전송", exact: true }).click();
  await page.locator('[data-test-class~="message-list"]').waitFor();
  await page.getByText("Paragraph 80: Synthetic conversation for layout verification.", { exact: false }).waitFor();
  for (const width of [1440, 1180, 390]) for (const theme of ["light", "dark"]) for (const kind of ["riso-print", "bloom", "none"]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme,
      conversation_background: { source: source(kind), overlay: 70 } }) });
    await page.waitForFunction(tone => document.querySelector(`[data-theme="${tone}"]`), theme);
    if (stage === "after" && kind !== "none") {
      await page.waitForFunction(module => document.querySelector('[data-test-class~="conversation-wallpaper"]')?.getAttribute("data-painted-module") === `butler.${module}`, kind);
      await page.waitForFunction(tone => document.querySelector('[data-test-class~="conversation-wallpaper"]')?.getAttribute("data-painted-tone") === tone, theme);
      assert.equal(await page.locator('[data-slot="conversation-background"]').count(), 1);
      const paper = page.locator('[data-test-class="wallpaper-paper"]');
      assert.equal(await paper.count(), kind === "bloom" ? 1 : 0);
      if (kind === "bloom") {
        const paint = await paper.evaluate(e => {
          const r = e.getBoundingClientRect(), host = e.closest('[data-slot="conversation-background"]')!.getBoundingClientRect();
          const style = getComputedStyle(e);
          return { opacity: style.opacity, color: style.backgroundColor, coverage: [r.x-host.x, r.y-host.y, r.width-host.width, r.height-host.height] };
        });
        assert.equal(paint.opacity, "0.7");
        assert.equal(paint.color, theme === "light" ? "rgb(250, 250, 248)" : "rgb(25, 28, 36)");
        assert(paint.coverage.every(delta => Math.abs(delta) <= 1), "One uniform overlay covers the entire conversation card");
      }
    }
    await capture(page, "conversation", width, theme, kind);
  }
  writeFileSync(join(out, "screenshots.json"), JSON.stringify({ stage, shots, stubCalls: server.stubModelCalls.length }, null, 2));
  console.log(JSON.stringify({ stage, screenshots: shots.length, output: out }));
} catch (error) {
  writeFileSync(join(out, "failure.json"), JSON.stringify({ error: String(error), stubCalls: server.stubModelCalls.length }));
  writeFileSync(join(out, "agent.log"), server.diagnostics());
  throw error;
} finally { try { await browser.close(); } finally { await server.stop(); } }
