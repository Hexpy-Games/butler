// Compare every Settings route and shared blocks against immutable preview.8.
// Baseline product source is never patched; the native gateway is isolated.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { smokeBrowserArgs } from "../support/smoke-browser.ts";
import { assertNewChatSurfaces } from "../support/newchat-visual.ts";

const output = resolve(process.env.BUTLER_SETTINGS_COMPARISON ?? ".tmp/settings-release-comparison");
const temporary = mkdtempSync(join(tmpdir(), "settings-preview8-"));
const revision = execFileSync("git", ["rev-parse", "v0.1.0-preview.8^{commit}"], { encoding: "utf8" }).trim();
const sections = ["General", "Appearance", "Personalization", "Memory", "Models", "Updates", "Usage", "Privacy", "Security", "System events", "Archives", "About", "MCP", "Skills", "Server"];
const report: unknown[] = [];

async function capture(page: Page, directory: string, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getAnimations().every(animation =>
    animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`);
  await page.screenshot({ path: join(directory, `${name}.png`), fullPage: true });
}

async function matrix(uiRoot: string, stage: string) {
  const directory = join(output, stage);
  mkdirSync(directory, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    for (const complete of [true, false]) {
      const server = await createNativeAppServer({ uiRoot, onboardingComplete: complete });
      try {
        await server.signIn(page);
        for (const width of [1280, 375]) for (const theme of ["light", "dark"]) for (const wallpaper of [false, true]) {
          const name = `${width}-${theme}-${wallpaper ? "wallpaper" : "plain"}`;
          console.log(`Settings comparison ${stage} ${complete ? "completed" : "pending"} ${name}`);
          const now = "2026-10-03T06:25:00Z";
          await page.setViewportSize({ width, height: 1000 });
          await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: theme,
            onboarding: { consent_version: 2, accepted_at: now, completed_at: now },
            wallpaper: { source: wallpaper ? { kind: "live", module: "butler.shoreline", params: { realtime: false } } : { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
          await page.goto(server.url, { waitUntil: "load" });
          await page.locator('[data-test-class="new-chat-suggestion"]').first().waitFor();
          await assertNewChatSurfaces(page);
          await capture(page, directory, `newchat-${complete ? "completed" : "pending"}-${name}`);
          if (!complete) continue;
          for (const section of sections) {
            server.assertRunning();
            console.log(`Settings comparison ${stage} ${name} ${section}`);
            await page.goto(server.url, { waitUntil: "load" });
            await page.locator('[data-test-class~="composer-card"]').waitFor();
            const settings = page.getByRole("button", { name: "Settings", exact: true });
            if (!await settings.isVisible()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
            await settings.click();
            const button = page.getByRole("button", { name: section, exact: true });
            if (!await button.count()) {
              assert(stage === "before" && section === "Memory", `${stage}: missing ${section}`);
              report.push({ stage, name, section, present: false });
              continue;
            }
            await button.click();
            await page.locator('[data-test-class~="settings-detail-title"]').filter({ hasText: section }).waitFor();
            await capture(page, directory, `settings-${section.replaceAll(" ", "-")}-${name}`);
            report.push({ stage, name, section, present: true, text: await page.locator('[data-test-class~="settings-detail"]').allTextContents() });
          }
        }
        if (complete) for (const width of [1280, 375]) for (const theme of ["light", "dark"]) for (const [kind, block] of [["blocks", "Notice"], ["components", "Button"], ["blocks", "SetupWizardShell"]]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.goto(`${server.url}?visual=design-system&page=${kind}/${block}&theme=${theme}&locale=en&width=${width}&motion=reduced`);
          await page.locator(`[data-ds-detail="${block}"] [data-ds-examples]`).waitFor();
          await capture(page, directory, `shared-${block}-${width}-${theme}`);
        }
        assert.equal(server.stubModelCalls.length, 0, "Screens render without model calls");
      } finally { await server.stop(); }
    }
  } finally { await browser.close(); }
}

try {
  const cached = process.env.BUTLER_SETTINGS_BASELINE_UI;
  let baseline = cached;
  if (!baseline) {
    const archive = join(temporary, "source.tar");
    execFileSync("git", ["archive", revision, "--output", archive]);
    execFileSync("tar", ["-xf", archive, "-C", temporary]);
    rmSync(archive);
    execFileSync(process.env.BUTLER_BUN ?? "bun", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: temporary, stdio: "inherit" });
    execFileSync("npm", ["--prefix", "packages/butler-app/client/ui", "run", "build"], { cwd: temporary, stdio: "inherit" });
    baseline = join(temporary, "packages/butler-app/client/ui/dist");
  }
  await matrix(resolve(baseline), "before");
  await matrix(resolve("packages/butler-app/client/ui/dist"), "after");
  writeFileSync(join(output, "report.json"), JSON.stringify({ revision, candidate: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), report }, null, 2));
  console.log(JSON.stringify({ ok: true, revision, screens: report.length, output }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
