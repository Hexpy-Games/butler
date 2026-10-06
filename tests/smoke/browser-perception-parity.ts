// test-category: pure-logic
import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { HitTestedProvider } from "../browser-eval/hit-tested-provider";
import { startFixtureServer, readTruth } from "../fixtures/browser/server";
import { launchSmokeBrowser } from "../support/smoke-browser";

const output = process.env.BUTLER_BROWSER_PARITY_OUTPUT; assert.ok(output);
const fixture = startFixtureServer(), browser = await launchSmokeBrowser(fixture.resolverArgs);
const full = new HitTestedProvider(true), optimized = new HitTestedProvider(), rows = [];
try {
  const context = await browser.newContext({viewport:{width:1280,height:800}});
  for (let n=1;n<=20;n++) {
    const id=`F${String(n).padStart(2,"0")}`, truth=await readTruth(id), page=await context.newPage();
    await page.goto(fixture.url(id));
    await Promise.all(page.frames().map(frame=>frame.evaluate("document.fonts.ready")));
    if(truth.settleMs) await page.waitForTimeout(truth.settleMs);
    const loadAverage1m=loadavg()[0], before=await full.snapshot(page), after=await optimized.snapshot(page);
    assert.deepEqual(after.nodes,before.nodes,`${id} complete target order, flags and refs`);
    assert.equal(after.text,before.text,`${id} complete page text`);
    rows.push({id,nodes:after.nodes.length,bytes:Buffer.byteLength(after.text),fullMs:before.scriptMs,optimizedMs:after.scriptMs,loadAverage1m});
    await page.close();
  }
  assert.equal(rows.length,20);
  await writeFile(output,JSON.stringify({status:"passed",rows},null,2));
  console.log("20 fixture snapshots preserve the full walk/grid content.");
} finally {await browser.close();fixture.stop();}
