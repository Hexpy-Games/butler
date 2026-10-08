/** Bounded 20-minute A/B diagnostic; never substitutes for the full 2h gate.
 * Run isolated, with BUTLER_P0_EVIDENCE set, passing native or rss.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchP0App, waitFor } from "./browser-p0-app";
import { browserP0Fixtures } from "./browser-p0-fixtures";
import { hostWindow, HostLoadExceeded } from "./browser-p0-host-load";
import { seedP0OwnerScale, waitP0OwnerScaleSpace } from "./browser-p0-owner-scale";
import { runSoakLoop } from "./browser-p0-soak";
import { sample } from "./browser-p0-measure";
import { openBrowserArea, visitUserSite } from "./browser-p0-user";

const variant = process.argv[2];
assert(["native", "rss"].includes(variant!), "Select native or rss checkpoints");
const evidence = process.env.BUTLER_P0_EVIDENCE!;
assert(evidence, "Evidence directory required");
mkdirSync(evidence, { recursive: true });
const fixtures = browserP0Fixtures(), origin = `http://127.0.0.1:${fixtures.port}`;
let app: Awaited<ReturnType<typeof launchP0App>> | undefined;
try {
  app = await launchP0App();
  await waitP0OwnerScaleSpace(app.data);
  const ownerScale = seedP0OwnerScale(app.data);
  await app.page.reload(); await openBrowserArea(app);
  await visitUserSite(app, `${origin}/nodes`, evidence);
  for (const path of ["nodes", "cpu", "network"]) {
    await app.main.evaluate(`browserP0.open('warm','${origin}/${path}')`);
    try { await app.main.evaluate("browserP0.step('warm')"); }
    finally { await app.main.evaluate("browserP0.close('warm')"); }
  }
  await Bun.sleep(60_000);
  const measured = await hostWindow(`20 min attribution ${variant}`, async () => {
    const before = await sample(app!);
    const productBefore = await app!.main.evaluate("browserP0.productInventory()");
    const sessionsBefore = await app!.main.evaluate("browserP0.sample().sessionsCreated");
    await app!.main.evaluate("browserP0.resetDelay()");
    await app!.main.evaluate(`browserP0.openProductGPU('user','${origin}/video')`);
    await waitFor(() => app!.main.evaluate("browserP0.evaluate('user','video.readyState>=3&&!video.paused')"), "USER video playing");
    const loop = await runSoakLoop(app!, origin, 20, evidence, variant === "native");
    await app!.main.evaluate("browserP0.close('user')");
    await Bun.sleep(50);
    const after = await sample(app!);
    const outliers = await app!.main.evaluate("browserP0.delayOutliers()");
    assert.equal((await app!.main.evaluate<{ count: number }>("browserP0.productErrors()")).count, 0);
    assert.deepEqual(await app!.main.evaluate("browserP0.productInventory()"), productBefore);
    assert.equal(await app!.main.evaluate("browserP0.sample().sessionsCreated"), sessionsBefore);
    assert.deepEqual(after.resources, before.resources);
    return { loop, mainLoop: after.loop, outliers, resources: after.resources, productBefore };
  });
  const result = { variant, ownerScale, ...measured, diagnosticOnly: true };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  writeFileSync(join(evidence, "error.json"), JSON.stringify({ variant, error: String(error) }));
  console.error(String(error)); process.exitCode = error instanceof HostLoadExceeded ? 75 : 1;
} finally {
  if (app) await app.stop(); fixtures.stop(true);
}
