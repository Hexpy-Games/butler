// test-category: pure-logic
// No model calls. Provider injection is the P2a seam; A0 deliberately has no visibility filtering.
import { scrollVirtualizedFixture } from "../support/browser-virtualized-fixture";
import { loadavg } from "node:os";
import { HitTestedProvider } from "../browser-eval/hit-tested-provider";
import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { startFixtureServer, readTruth } from "../fixtures/browser/server.ts";
import type { L1Metrics, SnapshotProvider } from "../browser-eval/contracts.ts";
import { RawA11yProvider } from "../browser-eval/raw-a11y-provider.ts";
import { scoreSnapshot } from "../browser-eval/scoring.ts";

export async function runPerception(provider: SnapshotProvider, output: string) {
  assert(process.env.HOME && process.env.BUTLER_DATA, "Run with isolated HOME/BUTLER_DATA");
  const fixture = startFixtureServer();
  const browser = await launchSmokeBrowser(fixture.resolverArgs);
  const rows: L1Metrics[] = [];
  await mkdir(output, { recursive: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, locale: "ko-KR", timezoneId: "Asia/Seoul" });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (!url.hostname.endsWith(".test")) throw new Error(`External request ${url.origin}`);
      await route.continue();
    });
    for (let n = 1; n <= 20; n++) {
      const id = `F${String(n).padStart(2, "0")}`;
      const truth = await readTruth(id);
      const page = await context.newPage();
      await page.goto(fixture.url(id));
      await Promise.all(page.frames().map((frame) => frame.evaluate("document.fonts.ready")));
      if (truth.settleMs) await page.waitForTimeout(truth.settleMs);
      if (id === "F10") await scrollVirtualizedFixture(page);
      const loadAverage1m = loadavg()[0];
      const snapshot = await provider.snapshot(page);
      rows.push({ ...scoreSnapshot(truth, provider.arm, snapshot), loadAverage1m } as L1Metrics);
      await writeFile(resolve(output, `${id}.snapshot.json`), JSON.stringify(snapshot, null, 2));
      await page.screenshot({ path: resolve(output, `${id}.png`) });
      await page.close();
    }
    assert.equal(rows.length, 20);
    const totals = rows.reduce((sum, row) => ({ realFound: sum.realFound + row.realFound, realTotal: sum.realTotal + row.realTotal,
      decoysLeaked: sum.decoysLeaked + row.decoysLeaked, decoysTotal: sum.decoysTotal + row.decoysTotal,
      coveredCorrect: sum.coveredCorrect + row.coveredCorrect, coveredTotal: sum.coveredTotal + row.coveredTotal }),
    { realFound: 0, realTotal: 0, decoysLeaked: 0, decoysTotal: 0, coveredCorrect: 0, coveredTotal: 0 });
    const report = { schema: "butler.browser-eval.l1.v1", arm: provider.arm, engine: browser.version(), viewport: [1280, 800], scale: 1,
      clock: "2026-10-06T12:00:00.000Z", seed: 737, tokenEstimate: "ceil(UTF-8 bytes / 4); not provider usage",
      totals, rows, requests: fixture.events };
    await writeFile(resolve(output, "l1.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...totals, snapshotBytes: rows.reduce((s, r) => s + r.snapshotBytes, 0), scriptMs: rows.reduce((s, r) => s + r.scriptMs, 0), loadAverage1m: loadavg()[0] }));
    return report;
  } finally { await browser.close(); fixture.stop(); }
}

if (import.meta.main) {
  if (!process.env.BUTLER_BROWSER_EVAL_OUTPUT) throw new Error("Set BUTLER_BROWSER_EVAL_OUTPUT outside the repository");
  await runPerception(process.env.BUTLER_BROWSER_EVAL_ARM === "A1" ? new HitTestedProvider() : new RawA11yProvider(), resolve(process.env.BUTLER_BROWSER_EVAL_OUTPUT));
}
