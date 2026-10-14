// test-category: race
/** Pending onboarding comparison on the real App renderer and isolated native gateway. */
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";
const root = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(root);
const evidence = join(root, process.env.BUTLER_RAIL_BASELINE === "1" ? "before" : "after", "pending-onboarding");
mkdirSync(evidence, { recursive: true });
const server = await createNativeAppServer({ onboardingComplete: false,
  uiRoot: process.env.BUTLER_SMOKE_RENDERER_DIST ?? resolve("packages/butler-app/client/ui/dist") });
const browser = await launchSmokeBrowser();
try {
  const context = await browser.newContext(); await server.signIn(context);
  const page = await context.newPage();
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) for (const wallpaper of [false, true]) {
    const source = wallpaper ? { kind: "live", module: "butler.riso-print" } : { kind: "none" };
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
      reduce_motion: true, wallpaper: { source, motion: "paused", pauseOnBattery: true }, conversation_background: { source, overlay: 0 } }) });
    await page.setViewportSize({ width, height: 900 }); await page.goto(server.url);
    await page.locator("[data-test-class=first-run-setup]").waitFor();
    await page.waitForFunction(() => !document.querySelector("[data-test-class=first-run-setup]")?.getAnimations({ subtree: true }).some(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity));
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await page.screenshot({ path: join(evidence, `${theme}-${width}-${wallpaper ? "wallpaper" : "plain"}.png`) });
  }
  console.log("pending onboarding: 8 captures");
} finally { await browser.close(); await server.stop(); }
