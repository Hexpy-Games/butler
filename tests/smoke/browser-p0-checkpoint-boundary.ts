/** Real-App check: native probes bracket, and cannot change, the frozen window. */
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchP0App, waitFor } from "./browser-p0-app";
import { browserP0Fixtures } from "./browser-p0-fixtures";
import { memoryCheckpoint } from "./browser-p0-memory";
import { sample } from "./browser-p0-measure";

const evidence = process.env.BUTLER_P0_EVIDENCE!;
assert(evidence, "Evidence directory required");
mkdirSync(evidence, { recursive: true });
const fixtures = browserP0Fixtures(), origin = `http://127.0.0.1:${fixtures.port}`;
let app: Awaited<ReturnType<typeof launchP0App>> | undefined;
try {
  app = await launchP0App();
  await app.main.evaluate(`browserP0.openProductGPU('user','${origin}/video')`);
  await waitFor(() => app!.main.evaluate("browserP0.evaluate('user','video.readyState>=3&&!video.paused')"), "USER video playing");
  const nativeStart = await memoryCheckpoint(app, evidence, "boundary-start-native");
  const start = await app.main.evaluate<string>("browserP0.resetDelay()");
  const firstFrames = await app.main.evaluate<number>("browserP0.evaluate('user','video.getVideoPlaybackQuality().totalVideoFrames')");
  for (const path of ["nodes", "cpu", "network"]) {
    await app.main.evaluate(`browserP0.open('boundary','${origin}/${path}')`);
    try { await app.main.evaluate("browserP0.step('boundary')"); }
    finally { await app.main.evaluate("browserP0.close('boundary')"); }
  }
  await memoryCheckpoint(app, evidence, "boundary-interval", false, false);
  await Bun.sleep(250);
  const finalFrames = await app.main.evaluate<number>("browserP0.evaluate('user','video.getVideoPlaybackQuality().totalVideoFrames')");
  assert(finalFrames > firstFrames, "USER video advances throughout measured work");
  await app.main.evaluate("browserP0.close('user')");
  await app.page.expression("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  const end = await app.main.evaluate<string>("browserP0.finishDelay()");
  const beforeNativeEnd = (await sample(app)).loop;
  const outliersBefore = await app.main.evaluate("browserP0.delayOutliers()");
  const nativeEnd = await memoryCheckpoint(app, evidence, "boundary-end-native");
  await Bun.sleep(50);
  const afterNativeEnd = (await sample(app)).loop;
  assert.deepEqual(afterNativeEnd, beforeNativeEnd, "End inspection cannot contaminate the frozen histogram");
  assert.deepEqual(await app.main.evaluate("browserP0.delayOutliers()"), outliersBefore, "End inspection cannot contaminate the measured timeline");
  const actions = readFileSync(join(evidence, "checkpoint-actions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  for (const action of actions) {
    if (action.label === "boundary-start-native") assert(action.at <= start);
    if (action.label === "boundary-end-native") assert(action.at >= end);
    if (action.label === "boundary-interval") assert(!["vmmap", "footprint", "heapSnapshot"].includes(action.action));
  }
  const result = { measurement: { start, end }, nativeStart, nativeEnd, beforeNativeEnd, afterNativeEnd, firstFrames, finalFrames, diagnosticOnly: true };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ measurement: result.measurement, beforeNativeEnd, afterNativeEnd, firstFrames, finalFrames }));
} finally {
  if (app) await app.stop(); fixtures.stop(true);
}
