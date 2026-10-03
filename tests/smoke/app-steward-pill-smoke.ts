import { smokeBrowserArgs } from "../support/smoke-browser.ts";
// The Steward composer pill on the visual harness (built UI served by an
// isolated native gateway): shown while an #307-shaped child is admitted or
// finalizing its answer, gone once the child is terminal.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createNativeAppServer } from "../support/native-app-server.ts";

const dir = mkdtempSync(join(tmpdir(), "butler-steward-pill-"));
const server = await createNativeAppServer({
  butlerData: join(dir, "data"),
  uiRoot: resolve("packages/butler-app/client/ui/dist"),
});
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await server.signIn(page);
  const pill = page.locator('[data-test-class~="steward-progress-capsule"]');
  const card = page.locator('[data-test-class~="steward-parent-progress-card"]');
  for (const [state, visible] of [["", true], ["finalizing", true], ["delivered", false]] as const) {
    await page.goto(`${server.url}?visual=components&surface=ss03${state ? `&steward=${state}` : ""}`);
    // The card is anchored to the hand-off answer in every state.
    await card.waitFor();
    if (visible) await pill.waitFor();
    assert.equal(await pill.count(), visible ? 1 : 0, `pill for the ${state || "admitted"} child`);
  }
  console.log(JSON.stringify({
    ok: true,
    service: "butler-app-steward-pill-smoke",
    checks: ["admitted-child-pill", "finalizing-child-pill", "terminal-child-no-pill"],
  }));
} finally {
  await browser.close();
  await server.stop();
  rmSync(dir, { recursive: true, force: true });
}
