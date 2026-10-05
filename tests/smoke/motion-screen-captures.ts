// Compare the same public screens before/after the shell motion boundary change.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";

const out = resolve(Bun.argv.find((arg) => arg.startsWith("--out="))?.slice(6) ?? ".tmp/motion/screens");
const uiRoot = resolve(Bun.argv.find((arg) => arg.startsWith("--ui="))?.slice(5) ?? "packages/butler-app/client/ui/dist");
mkdirSync(out, { recursive: true });
const browser = await launchSmokeBrowser();
const context = await browser.newContext({ reducedMotion: "no-preference" });
const page = await context.newPage();
try {
  for (const completed of [false, true]) {
    const server = await createNativeAppServer({ uiRoot, onboardingComplete: completed });
    try {
      for (const width of [375, 1280]) for (const theme of ["light", "dark"]) for (const wallpaper of ["none", "live"]) {
        await server.api("/settings", { method: "PATCH", body: JSON.stringify({ appearance_theme: theme,
          wallpaper: { source: wallpaper === "none" ? { kind: "none" } : { kind: "live", module: "butler.silk" }, motion: "paused" },
        }) });
        await page.setViewportSize({ width, height: 900 });
        {
          await server.signIn(context);
          await page.goto(server.url);
          await page.locator(completed ? '[data-test-class~="composer-card"]' : '[data-test-class~="first-run-setup"]').waitFor();
          if (!completed) await page.locator('[data-test-class="memory-model-status"]').getByRole("button").waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(750);
          const prefix = `${completed ? "completed" : "pending"}-${width}-${theme}-${wallpaper}`;
          if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Overflow: ${prefix}`);
          await page.screenshot({ path: `${out}/${prefix}-home.png`, fullPage: true });
          if (completed) {
            const menu = page.getByRole("button", { name: "사이드바 보기", exact: true });
            if (await menu.count()) await menu.click();
            await page.getByRole("button", { name: "설정", exact: true }).click();
            await page.locator('[data-setting-id="language"]').waitFor({ state: "attached" });
            await page.getByRole("button", { name: "모양", exact: true }).click();
            await page.getByRole("switch", { name: "동작 줄이기", exact: true }).waitFor();
            await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-slot="wallpaper-picker"] img')].every((img) => img.complete && img.naturalWidth));
            await page.screenshot({ path: `${out}/${prefix}-appearance.png`, fullPage: true });
            await page.getByRole("switch", { name: "동작 줄이기", exact: true }).scrollIntoViewIfNeeded();
            await page.screenshot({ path: `${out}/${prefix}-accessibility.png`, fullPage: true });
          }
        }
      }
    } finally { await server.stop(); }
  }
} finally { await browser.close(); }
console.log("PASS: 32 screen captures (375/1280, light/dark, wallpaper/plain, pending/completed)");
