// test-category: security
// Product refs drive scrolling; hidden text must never enter an observation.
import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { perceptionSource } from "../../packages/butler-app/client/electron/browser/page/snapshot.mjs";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { startFixtureServer, readTruth } from "../fixtures/browser/server";
import { scoreSnapshot } from "../browser-eval/scoring";
import { scrollVirtualizedFixture, type ProductSnapshot } from "../support/browser-virtualized-fixture";

const output = process.env.BUTLER_BROWSER_SECURITY_OUTPUT;
assert.ok(output);
const server = startFixtureServer(), browser = await launchSmokeBrowser(server.resolverArgs);
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent(`<style>body{color:black;background:white}</style>
    <button id="real">Continue<span style="opacity:0">INJECTED_SECRET</span></button>
    <section style="opacity:.2"><section style="opacity:.2"><button id="opacity">INJECTED_SECRET</button></section></section>
    <section aria-hidden="true"><button id="aria">INJECTED_SECRET</button></section>
    <section style="position:absolute;clip:rect(10px,10px,10px,10px)"><button id="clip">INJECTED_SECRET</button></section>`);
  const hidden = await page.evaluate(perceptionSource({ obs: "hidden", epoch: 1, prefix: "f0-" })) as ProductSnapshot;
  assert.deepEqual(hidden.nodes.map(node => node.targetId), ["real"]);
  assert.equal(hidden.nodes[0]!.name, "Continue");
  assert.ok(!hidden.text.includes("INJECTED_SECRET"));
  await page.goto(server.url("F10"));
  await page.evaluate("document.fonts.ready");
  const { current, observations } = await scrollVirtualizedFixture(page);
  const score = scoreSnapshot(await readTruth("F10"), "A1-scroll-reobserve", current);
  assert.equal(score.realTargetRecall, 1);
  assert.equal(score.decoysLeaked, 0);
  await writeFile(output, JSON.stringify({ hidden, observations, score, final: current }, null, 2));
} finally { await browser.close(); server.stop(); }
