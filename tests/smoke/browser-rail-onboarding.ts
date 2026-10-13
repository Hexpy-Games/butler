// test-category: race
/** Pending onboarding comparison in the real App, without browser tabs or providers. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
const root = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(root);
const evidence = join(root, process.env.BUTLER_RAIL_BASELINE === "1" ? "before" : "after", "pending-onboarding");
mkdirSync(evidence, { recursive: true });
const app = await browserAgentApp(evidence, () => null, undefined, { onboardingComplete: false });
try {
  for (const theme of ["light", "dark"]) for (const width of [1440, 390]) for (const wallpaper of [false, true]) {
    const source = wallpaper ? { kind: "live", module: "butler.riso-print" } : { kind: "none" };
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme,
      reduce_motion: true, wallpaper: { source, motion: "paused", pauseOnBattery: true }, conversation_background: { source, overlay: 0 } }) });
    await app.main(`${app.win}.setContentSize(${width},900)`); await app.page.reload();
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=conversation]'))"), "pending onboarding loaded");
    await app.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    writeFileSync(join(evidence, `${theme}-${width}-${wallpaper ? "wallpaper" : "plain"}.png`), await app.page.screenshot());
  }
  console.log("pending onboarding: 8 captures");
} finally { await app.stop(); }
