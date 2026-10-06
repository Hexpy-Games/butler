// test-category: pure-logic
import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { evaluateSuccess, readTruth, startFixtureServer } from "../fixtures/browser/server.ts";
import { completeFixture } from "../browser-eval/fixture-actions.ts";

const fixtures = startFixtureServer();
const browser = await launchSmokeBrowser(fixtures.resolverArgs);
const results: { id: string; success: boolean; decoyRejected: boolean }[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "ko-KR" });
  for (let n = 1; n <= 20; n++) {
    const id = `F${String(n).padStart(2, "0")}`;
    const truth = await readTruth(id);
    const start = fixtures.events.length;
    const page = await context.newPage();
    await page.goto(fixtures.url(id)); await Promise.all(page.frames().map((frame) => frame.evaluate("document.fonts.ready")));
    if (truth.settleMs) await page.waitForTimeout(truth.settleMs);
    assert.equal(evaluateSuccess(truth, fixtures.events.slice(start)), false, `${id}: initial state must not pass`);
    await completeFixture(page, id);
    for (const frame of page.frames()) await frame.evaluate("flushEvents()");
    const events = fixtures.events.slice(start);
    const serverResult = await page.evaluate(async (id) => (await fetch(`/result?fixture=${id}`)).json(), id);
    assert.equal(serverResult.success, true, `${id}: server result endpoint`);
    assert(evaluateSuccess(truth, events), `${id}: gold path must pass; ${JSON.stringify(events.filter((e) => e.type !== "request"))}`);
    let decoyRejected = true;
    if (truth.decoys.length) {
      const status = await page.evaluate(async (event) => (await fetch("/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) })).status, { fixture: id, target: truth.decoys[0], type: "click" });
      assert.equal(status, 204);
      decoyRejected = !evaluateSuccess(truth, fixtures.events.slice(start));
      assert(decoyRejected, `${id}: server must fail a received decoy hit`);
    }
    if (truth.success.forbidden.length) {
      const path = truth.success.forbidden[0].target;
      const host = id === "F19" ? "evil.fixture.test" : new URL(page.url()).hostname;
      await page.evaluate(async (url) => { await fetch(url, { mode: "no-cors" }); }, `http://${host}:${fixtures.server.port}${path}`);
      assert(!evaluateSuccess(truth, [...events, ...fixtures.events.slice(start).filter((e) => e.type === "request" && e.target === path)]), `${id}: forbidden request must fail`);
      assert(fixtures.events.slice(start).some((e) => e.fixture === id && e.target === path && e.type === "request"));
    }
    results.push({ id, success: true, decoyRejected }); await page.close();
  }
  if (process.env.BUTLER_BROWSER_EVAL_OUTPUT) await writeFile(resolve(process.env.BUTLER_BROWSER_EVAL_OUTPUT, "fixture-smoke.json"), JSON.stringify({ results, events: fixtures.events }, null, 2));
  console.log(`Fixture gold paths and server predicates: ${results.length}/20 passed`);
} finally { await browser.close(); fixtures.stop(); }
